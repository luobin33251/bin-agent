// 会话与 Agent 事件相关的类型

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  name: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// 工具调用的信息，用于向前端展示调用过程
export interface ToolCallInfo {
  id: string; // 调用 ID，由 LLM 生成，用于关联 tool_call 与 tool_result
  name: string; // 工具名称
  arguments: Record<string, unknown>; // 调用参数
  result?: string; // 执行结果（tool_result 事件时才有值）
  error?: string; // 错误信息（执行失败时有值）
  modelUsed?: string; // 工具内部实际使用的模型（部分工具会回传）
}

// Agent 把 LLM 的 chunk 转换成的事件流
export type AgentEvent =
  | { type: 'assistant_message'; content: string } // 模型正在输出内容
  | { type: 'assistant_message_end'; content: string } // 本轮模型输出结束
  | { type: 'tool_call'; toolCall: ToolCallInfo } // 开始调用工具
  | { type: 'tool_result'; toolCall: ToolCallInfo } // 工具返回结果
  | { type: 'error'; error: string } // 发生错误
  | { type: 'done'; finalMessage: string }; // 整个流程结束

export interface AgentConfig {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number; // ReAct 循环最大轮数
}