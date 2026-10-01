// 与后端 SSE 接口对应的类型与调用封装

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  error?: string;
  modelUsed?: string;
}

// 与 packages/bin-server/src/tools/memory-card.ts 保持一致
export interface MemoryCardField {
  label: string;
  value: string;
}

export interface MemoryCardChange {
  label: string;
  from: string;
  to: string;
}

export interface MemoryCard {
  kind: 'saved' | 'corrected' | 'deleted' | 'merged' | 'restored';
  itemId: string;
  typeName: string;
  /** 本次是否新建了类别 */
  typeIsNew: boolean;
  title: string;
  summary?: string;
  status?: string;
  occurredAt?: number;
  fields: MemoryCardField[];
  relationCount: number;
  confidence?: number;
  /** 纠正时列出改了哪些字段 */
  changes?: MemoryCardChange[];
  /** 合并时被并入并移除的那条记录的标题 */
  mergedFrom?: string;
}

export type StreamEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'assistant_message_end'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo }
  | { type: 'tool_result'; toolCall: ToolCallInfo }
  | { type: 'memory_card'; card: MemoryCard }
  | { type: 'done'; finalMessage: string }
  | { type: 'error'; error: string };

/**
 * 调用流式对话接口。
 * 用 fetch + ReadableStream 而不是 EventSource，因为 EventSource 只支持 GET。
 */
export async function streamChat(
  body: { sessionId?: string; message: string },
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`请求失败：HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 用空行分隔事件
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as StreamEvent);
        } catch {
          // 忽略无法解析的行，避免破坏整条流
        }
      }
    }
  }
}