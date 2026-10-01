// LLM 调用相关的公共类型定义
// 这一层只描述"跟模型打交道"需要的数据结构，不含业务字段

// 工具参数描述（JSON Schema 的一个够用子集）
// 递归结构：save_memory 这类工具需要传「对象数组」参数（如 data: [{key,label,value}]），
// 所以 items 必须能继续描述 properties
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolParameterSchema extends JSONSchemaProperty {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
}

// 暴露给模型的工具定义
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// 模型返回的完整工具调用
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// 流式到达的工具调用增量，需要按 index 分片拼接
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

// 已完成的工具调用（要回填进 assistant 消息，OpenAI 要求 tool_calls 与 tool 结果成对出现）
export interface CompletedToolCall {
  id: string;
  name: string;
  arguments: string; // 已序列化的 JSON 字符串，原样回传给模型
}

// 发给模型的消息（会话里的 Message 会先转换成本结构，丢掉 id、时间戳等模型不关心的字段）
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: CompletedToolCall[]; // role 为 assistant 时，本轮发起的工具调用
  toolCallId?: string; // role 为 tool 时，对应哪次工具调用
  name?: string; // role 为 tool 时，工具名称
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'error' | 'tool_calls';
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
}

export interface ChatChunk {
  content?: string;
  finishReason?: 'stop' | 'length' | 'error' | 'tool_calls';
  toolCalls?: ToolCallDelta[];
}

// 初始化 Provider 需要的配置
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}