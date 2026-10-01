import type { ToolParameterSchema } from '@bin/ai';

// 所有工具都要实现这个接口，Agent 才能把工具描述给模型并执行
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  modelUsed?: string;
  execute(params: Record<string, unknown>): Promise<string>;
}