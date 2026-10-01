import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Agent, AgentEvent } from '@bin/core';
import type { Config } from '../config.js';
import { buildSystemPrompt } from '../prompts/base.js';
import type { MemoryCard } from '../tools/memory-card.js';

interface ChatRequestBody {
  sessionId?: string;
  message: string;
}

// 会话与卡片事件不在 AgentEvent 里，由路由层从工具结果里识别后补发
type StreamEvent =
  | AgentEvent
  | { type: 'session'; sessionId: string }
  | { type: 'memory_card'; card: MemoryCard };

/**
 * 工具把回显卡片挂在结果的 _meta.card 上。
 * 走「工具结果里带元数据」而不是新加一种 AgentEvent：
 * 卡片是工具自己的产出，Agent 循环不需要知道它的存在。
 */
function extractCard(result?: string): MemoryCard | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { _meta?: { card?: MemoryCard } };
    return parsed?._meta?.card ?? null;
  } catch {
    return null;
  }
}

export function registerChatRoutes(app: FastifyInstance, agent: Agent, _config: Config): void {
  // 流式对话接口（SSE）
  app.post(
    '/api/chat/stream',
    async (request: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      const { sessionId, message } = request.body ?? {};

      if (!message || !message.trim()) {
        return reply.status(400).send({ error: 'message 不能为空' });
      }

      // 前端没带 sessionId 时由服务端开一个新会话，并在首个事件里回传。
      // 用 || 而非 ??：空字符串同样视为「没有传」，否则每轮都会新建会话导致上下文丢失
      const effectiveSessionId = sessionId?.trim() || agent.getSessionManager().create().id;

      // 接管响应，后续输出全部由这里直接写原始流
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (event: StreamEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      send({ type: 'session', sessionId: effectiveSessionId });

      try {
        // 每次请求现算系统提示词：里面带「今天几号」，长驻进程也不会用上过期日期
        const stream = agent.run(effectiveSessionId, message, { systemPrompt: buildSystemPrompt() });
        for await (const event of stream) {
          send(event);

          // 工具写入了记忆时，额外补发一条卡片事件，
          // 让前端把它渲染成结构化卡片，而不是从正文里解析
          if (event.type === 'tool_result') {
            const card = extractCard(event.toolCall.result);
            if (card) send({ type: 'memory_card', card });
          }
        }
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : '未知错误' });
      } finally {
        reply.raw.end();
      }
    },
  );

  // 非流式对话接口，便于脚本化调试
  app.post('/api/chat/send', async (request: FastifyRequest<{ Body: ChatRequestBody }>) => {
    const { sessionId, message } = request.body ?? {};

    if (!message || !message.trim()) {
      return { error: 'message 不能为空' };
    }

    const effectiveSessionId = sessionId?.trim() || agent.getSessionManager().create().id;
    let finalMessage = '';

    for await (const event of agent.run(effectiveSessionId, message, { systemPrompt: buildSystemPrompt() })) {
      if (event.type === 'done') finalMessage = event.finalMessage;
      if (event.type === 'error') return { sessionId: effectiveSessionId, error: event.error };
    }

    return { sessionId: effectiveSessionId, message: finalMessage };
  });
}