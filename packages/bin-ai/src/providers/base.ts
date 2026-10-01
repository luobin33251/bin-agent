import type { ChatChunk, ChatOptions, ChatResponse, LLMMessage, ProviderConfig } from '../types.js';

// 抽象基类：不能被实例化，只能被继承
// 用 abstract 修饰的成员，子类必须实现
export abstract class BaseLLMProvider {
  abstract readonly name: string;

  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // 非流式调用
  abstract chat(messages: LLMMessage[], options?: ChatOptions): Promise<ChatResponse>;

  // 流式调用
  abstract chatStream(messages: LLMMessage[], options?: ChatOptions): AsyncIterable<ChatChunk>;

  // 返回该 provider 支持的模型列表
  abstract getSupportedModels(): string[];
}