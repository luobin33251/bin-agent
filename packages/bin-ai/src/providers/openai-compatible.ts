import OpenAI from 'openai';
import type {
  ChatChunk,
  ChatOptions,
  ChatResponse,
  LLMMessage,
  ProviderConfig,
  ToolCall,
  ToolCallDelta,
  ToolDefinition,
} from '../types.js';
import { BaseLLMProvider } from './base.js';

// 默认指向阿里云百炼 MaaS 的 OpenAI 兼容端点
const DEFAULT_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';

// 显式兜底：单次请求最长 10 分钟、失败重试 2 次，避免僵死连接一直挂着
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;

type FinishReason = 'stop' | 'length' | 'error' | 'tool_calls';

/**
 * 通用 OpenAI 兼容 Provider。
 * 千问、DeepSeek、Kimi 等都提供 OpenAI 兼容接口，差别只在 baseUrl 和 model，
 * 因此不再为每家厂商各写一个类，统一用本类 + 配置区分。
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly name: string;

  private client: OpenAI;

  private defaultModel: string;

  constructor(config: ProviderConfig & { name?: string }) {
    super(config);

    this.name = config.name ?? 'openai-compatible';
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  /**
   * 校验密钥。放在调用时而不是构造时：
   * 本地工具不该因为还没填 Key 就拒绝启动，用户仍然可以打开界面、查看已有数据。
   */
  private assertConfigured(): void {
    if (!this.config.apiKey) {
      throw new Error(`${this.name}: 尚未配置 API Key，请在项目根目录 .env 中填写 LLM_API_KEY`);
    }
  }

  // ---------------- 非流式调用 ----------------

  async chat(messages: LLMMessage[], options?: ChatOptions): Promise<ChatResponse> {
    this.assertConfigured();
    try {
      const response = await this.client.chat.completions.create({
        model: options?.model ?? this.defaultModel,
        messages: this.toApiMessages(messages),
        temperature: options?.temperature,
        max_completion_tokens: options?.maxTokens,
        stream: false,
        tools: this.buildTools(options?.tools),
      });

      const choice = response.choices[0];
      const rawToolCalls = choice?.message?.tool_calls;

      return {
        content: choice?.message?.content ?? '',
        finishReason: this.mapFinishReason(choice?.finish_reason),
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
        toolCalls: rawToolCalls?.length
          ? rawToolCalls.map((call): ToolCall => ({
              id: call.id,
              name: call.function.name,
              arguments: parseArguments(call.function.arguments),
            }))
          : undefined,
      };
    } catch (error) {
      // 必须向上抛：吞掉错误返回空 content 会让调用方拿到"成功的空结果"继续往下走
      console.error(`[${this.name}] chat 调用失败:`, error);
      throw toError(error);
    }
  }

  // ---------------- 流式调用 ----------------

  async *chatStream(messages: LLMMessage[], options?: ChatOptions): AsyncIterable<ChatChunk> {
    this.assertConfigured();
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model ?? this.defaultModel,
        messages: this.toApiMessages(messages),
        temperature: options?.temperature,
        max_completion_tokens: options?.maxTokens,
        stream: true,
        tools: this.buildTools(options?.tools),
      });

      // 工具调用是分片到达的，按 index 聚合
      const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
      // 是否收到过结束帧：流"自然结束"但没收到结束帧，说明连接被中途掐断
      let finished = false;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        const finishReason = choice?.finish_reason;
        if (finishReason) finished = true;

        for (const toolCall of delta?.tool_calls ?? []) {
          const index = toolCall.index;
          if (!toolCallBuffers.has(index)) {
            toolCallBuffers.set(index, { id: '', name: '', arguments: '' });
          }
          const buffer = toolCallBuffers.get(index)!;
          if (toolCall.id) buffer.id = toolCall.id;
          if (toolCall.function?.name) buffer.name += toolCall.function.name;
          if (toolCall.function?.arguments) buffer.arguments += toolCall.function.arguments;
        }

        // 只有结束时才吐出聚合好的工具调用，中间分片对上层没有意义
        let toolCalls: ToolCallDelta[] | undefined;
        if (finishReason && toolCallBuffers.size > 0) {
          toolCalls = Array.from(toolCallBuffers.entries()).map(([index, buf]) => ({
            index,
            id: buf.id,
            name: buf.name,
            arguments: buf.arguments,
          }));
        }

        yield {
          content: delta?.content ?? '',
          finishReason: finishReason ? this.mapFinishReason(finishReason) : undefined,
          toolCalls,
        };
      }

      // 宁可显式失败，也不要把半截响应当成正常结果返回给上层
      if (!finished) {
        throw new Error('流式响应中断：上游未返回结束帧（连接可能被中途断开）');
      }
    } catch (error) {
      console.error(`[${this.name}] chatStream 调用失败:`, error);
      throw toError(error);
    }
  }

  getSupportedModels(): string[] {
    return [this.defaultModel];
  }

  // ---------------- 内部转换 ----------------

  /**
   * 把内部 LLMMessage 转成 OpenAI 接口要求的格式。
   * 关键点：assistant 的 tool_calls 与 role=tool 的 tool_call_id 必须成对出现，
   * 否则接口会报 "tool message without a preceding tool_calls"。
   */
  private toApiMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((message): OpenAI.ChatCompletionMessageParam => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId ?? '',
          content: message.content,
        };
      }

      if (message.role === 'assistant') {
        if (message.toolCalls?.length) {
          return {
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          };
        }
        return { role: 'assistant', content: message.content };
      }

      return { role: message.role, content: message.content };
    });
  }

  private buildTools(tools?: ToolDefinition[]) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
  }

  private mapFinishReason(reason?: string | null): FinishReason {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      default:
        return 'error';
    }
  }
}

// 模型返回的参数是 JSON 字符串，解析失败时按空对象处理，避免整轮对话崩掉
function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}