// 回显卡片的形状。
// 工具把卡片挂在返回结果的 _meta.card 上，路由层从 tool_result 里识别出来，
// 补发一条 memory_card 事件给前端——这样卡片是结构化组件，而不是让模型写进正文再解析。
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
  /** 本次是否新建了类别，用于卡片上标注 */
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
  /** 合并时被并入并软删除的那条记录的标题 */
  mergedFrom?: string;
}

/** 把卡片附到工具结果上 */
export function withCard(payload: Record<string, unknown>, card: MemoryCard): string {
  return JSON.stringify({ ...payload, _meta: { card } }, null, 2);
}

/** 与前端 apps/web/src/services/chat.ts 里的 MemoryCard 保持一致 */