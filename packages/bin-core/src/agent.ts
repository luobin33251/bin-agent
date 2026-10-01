import { randomUUID } from 'node:crypto';
import type { BaseLLMProvider, LLMMessage, ToolCall, ToolDefinition } from '@bin/ai';
import type { AgentConfig, AgentEvent, Message, Session, ToolCallInfo } from './types.js';
import type { Tool } from './tool.js';
import { SessionManager } from './session.js';

// 喂给模型的工具结果上限：超大结果只需要模型读开头的概要字段，
// 全量数据已经通过 tool_result 事件直达前端渲染，塞进上下文只会撑爆 token 甚至让请求失败
const MAX_TOOL_RESULT_CHARS = 60000;

function toModelToolContent(result: { error?: string; result?: string }): string {
  const raw = result.error ?? result.result ?? '';
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  return (
    raw.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[工具结果过长已截断：完整共 ${raw.length} 字符，全量数据已送达前端展示；如需总结请依据结果开头的概要字段]`
  );
}

export interface RunOptions {
  systemPrompt?: string;
  toolNames?: string[];
}

export class Agent {
  private provider: BaseLLMProvider;

  private config: AgentConfig;

  private sessionManager: SessionManager;

  private tools = new Map<string, Tool>();

  constructor(provider: BaseLLMProvider, config?: AgentConfig) {
    this.provider = provider;
    this.config = config ?? {};
    this.sessionManager = new SessionManager();
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /** 暴露已注册的工具名，便于启动时自检 */
  getRegisteredToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 轻量调用：不走 ReAct 循环、不写会话历史，供子 Agent 场景使用 */
  async chat(messages: LLMMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const response = await this.provider.chat(messages, {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
    return response.content;
  }

  /**
   * 核心方法：运行 Agent，以异步事件流的形式产出过程。
   * ReAct 循环：LLM 推理 → 有工具调用则执行 → 结果回灌 → 继续推理，直到模型不再调用工具。
   */
  async *run(sessionId: string, userMessage: string, options?: RunOptions): AsyncGenerator<AgentEvent> {
    try {
      const session = this.sessionManager.getOrCreate(sessionId);

      const userMsg: Message = {
        id: randomUUID(),
        role: 'user',
        content: userMessage,
        createdAt: new Date().toISOString(),
      };
      this.sessionManager.addMessage(session.id, userMsg);

      const systemPrompt = options?.systemPrompt ?? this.config.systemPrompt;
      const llmMessages: LLMMessage[] = this.buildMessages(session, systemPrompt);

      const maxIterations = this.config.maxIterations ?? 20;
      let finalContent = '';

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        let fullContent = '';
        const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

        const stream = this.provider.chatStream(llmMessages, {
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          tools: this.getToolDefinitions(options?.toolNames),
        });

        for await (const chunk of stream) {
          if (chunk.content) {
            fullContent += chunk.content;
            yield { type: 'assistant_message', content: chunk.content };
          }
          for (const tc of chunk.toolCalls ?? []) {
            if (!toolCallBuffers.has(tc.index)) {
              toolCallBuffers.set(tc.index, { id: '', name: '', arguments: '' });
            }
            const buffer = toolCallBuffers.get(tc.index)!;
            if (tc.id) buffer.id = tc.id;
            if (tc.name) buffer.name += tc.name;
            if (tc.arguments) buffer.arguments += tc.arguments;
          }
        }

        yield { type: 'assistant_message_end', content: fullContent };
        // 只记录非空回答：工具调用轮（无文本）不应把已有的结论覆盖成空串
        if (fullContent.trim()) {
          finalContent = fullContent;
        }

        if (toolCallBuffers.size === 0) {
          break;
        }

        const toolCalls: ToolCall[] = Array.from(toolCallBuffers.entries())
          .sort(([a], [b]) => a - b)
          .map(([, buf]) => ({
            id: buf.id,
            name: buf.name,
            arguments: parseArguments(buf.arguments),
          }));

        // 去重：按 (name, arguments) 分组，相同调用只执行一次
        const uniqueKey = (tc: ToolCall) => `${tc.name}:${JSON.stringify(tc.arguments)}`;
        const uniqueMap = new Map<string, ToolCall>();
        const idToUniqueKey = new Map<string, string>();
        for (const tc of toolCalls) {
          const key = uniqueKey(tc);
          idToUniqueKey.set(tc.id, key);
          if (!uniqueMap.has(key)) uniqueMap.set(key, tc);
        }
        const uniqueToolCalls = Array.from(uniqueMap.values());

        // 回填 assistant 轮：必须带上本轮发起的 tool_calls，否则后面的 tool 结果没有归属
        llmMessages.push({
          role: 'assistant',
          content: fullContent,
          toolCalls: uniqueToolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          })),
        });

        // 先告知前端所有要执行的工具（包括重复的）
        for (const toolCall of toolCalls) {
          yield {
            type: 'tool_call',
            toolCall: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
          };
        }

        // 并行执行（仅执行去重后的）
        const uniqueResults = await Promise.all(
          uniqueToolCalls.map((tc) => this.executeToolCall(tc)),
        );
        const keyToResult = new Map<string, ToolCallInfo>();
        uniqueToolCalls.forEach((tc, i) => keyToResult.set(uniqueKey(tc), uniqueResults[i]));

        // 按原始顺序返回结果（重复调用共享同一结果）
        for (const toolCall of toolCalls) {
          const result = keyToResult.get(idToUniqueKey.get(toolCall.id)!)!;
          yield { type: 'tool_result', toolCall: { ...result, id: toolCall.id } };
        }

        // 工具结果回灌上下文（只回灌去重后的，避免重复）
        for (const tc of uniqueToolCalls) {
          const result = keyToResult.get(uniqueKey(tc))!;
          llmMessages.push({
            role: 'tool',
            toolCallId: tc.id,
            name: tc.name,
            content: toModelToolContent(result),
          });
        }
      }

      this.sessionManager.addMessage(session.id, {
        id: randomUUID(),
        role: 'assistant',
        content: finalContent,
        createdAt: new Date().toISOString(),
      });

      yield { type: 'done', finalMessage: finalContent };
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : '未知错误' };
    }
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolCallInfo> {
    const base = { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments };
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      return { ...base, error: `未找到工具 "${toolCall.name}"` };
    }

    try {
      const result = await tool.execute(toolCall.arguments);

      // 部分工具内部会换用别的模型，通过结果里的 _meta.modelUsed 回传，便于前端标注
      let modelUsed = tool.modelUsed;
      try {
        const parsed = JSON.parse(result) as { _meta?: { modelUsed?: string } };
        if (parsed?._meta?.modelUsed) modelUsed = parsed._meta.modelUsed;
      } catch {
        // 结果不是 JSON，忽略
      }

      return { ...base, result, modelUsed };
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : '未知错误',
        modelUsed: tool.modelUsed,
      };
    }
  }

  private getToolDefinitions(toolNames?: string[]): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    const filtered = toolNames ? all.filter((tool) => toolNames.includes(tool.name)) : all;
    return filtered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private buildMessages(session: Session, systemPrompt?: string): LLMMessage[] {
    const messages: LLMMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of session.messages) {
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    return messages;
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}