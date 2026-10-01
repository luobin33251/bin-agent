import {
  appendEntry,
  getDatabase,
  getItemById,
  getTypeById,
  updateItem,
  type Item,
  type ItemType,
} from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';
import { asOptionalString, asRecordArray, asString, displayValue, parseDate } from './params.js';
import { withCard, type MemoryCard, type MemoryCardChange, type MemoryCardField } from './memory-card.js';

/**
 * 纠正一条已经存下来的记忆。
 *
 * 设计取舍：条目本身原地更新（否则用户会在列表里看到两条一样的记录），
 * 但每次纠正都会往 entries 追加一条记录，写明「改了哪些字段、从什么改成什么」。
 * entries 只增不改，所以可追溯性不受影响——这正是它存在的意义。
 */
export function createCorrectMemoryTool(deps: { vectors: MemoryVectors }): Tool {
  const { vectors } = deps;

  return {
    name: 'correct_memory',
    description:
      '当用户说刚才记错了、或者要修改某条已有记录时使用。只需要传要改的字段，没传的保持原样。' +
      '如果要纠正的记录不在当前对话上下文里，先用 search_memory 找到它的 id。',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: '要纠正的条目 id，从 search_memory 结果或上一步 save_memory 的返回里取。',
        },
        reason: {
          type: 'string',
          description: '用户说明纠正原因的原话，原样复制不要改写。会永久留存。',
        },
        title: { type: 'string', description: '新的标题，不改就不传' },
        summary: { type: 'string', description: '新的摘要，不改就不传' },
        data: {
          type: 'array',
          description: '要改的字段，只需包含发生变化的项。',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '字段标识' },
              label: { type: 'string', description: '字段中文名' },
              value: { type: 'string', description: '新的字段值' },
            },
            required: ['key', 'label', 'value'],
          },
        },
        status: { type: 'string', description: '新的状态值，不改就不传' },
        occurred_at: { type: 'string', description: '修正后的发生时间，ISO 格式，不改就不传' },
      },
      required: ['item_id', 'reason'],
    },

    async execute(params) {
      const db = getDatabase();
      const itemId = asString(params.item_id);
      const reason = asString(params.reason);

      if (!itemId) throw new Error('item_id 不能为空');
      if (!reason) throw new Error('reason 不能为空：必须说明用户因为什么要改');

      const before = getItemById(db, itemId);
      if (!before) throw new Error(`找不到 id 为 ${itemId} 的条目，请先用 search_memory 确认`);

      const type = getTypeById(db, before.typeId);
      const labelOf = new Map((type?.fields ?? []).map((field) => [field.key, field.label]));

      // ── 计算变更 ────────────────────────────────────────
      const changes: MemoryCardChange[] = [];

      const nextTitle = asOptionalString(params.title);
      if (nextTitle && nextTitle !== before.title) {
        changes.push({ label: '标题', from: before.title, to: nextTitle });
      }

      const nextSummary = asOptionalString(params.summary);
      if (nextSummary !== undefined && nextSummary !== before.summary) {
        changes.push({ label: '摘要', from: before.summary ?? '(空)', to: nextSummary });
      }

      const nextStatus = asOptionalString(params.status);
      if (nextStatus !== undefined && nextStatus !== before.status) {
        changes.push({ label: '状态', from: before.status ?? '(空)', to: nextStatus });
      }

      const nextOccurredAt = parseDate(params.occurred_at);
      if (nextOccurredAt !== undefined && nextOccurredAt !== before.occurredAt) {
        changes.push({
          label: '发生时间',
          from: formatDay(before.occurredAt),
          to: formatDay(nextOccurredAt),
        });
      }

      // data 走合并语义：只覆盖传上来的键，其余保持不动
      const mergedData = { ...(before.data ?? {}) };
      for (const row of asRecordArray(params.data)) {
        const key = asString(row.key) || asString(row.label);
        if (!key) continue;
        const label = asString(row.label) || labelOf.get(key) || key;
        const nextValue = displayValue(row.value);
        const prevValue = displayValue(mergedData[key]);
        if (nextValue !== prevValue) {
          changes.push({ label, from: prevValue || '(空)', to: nextValue });
        }
        mergedData[key] = nextValue;
      }

      if (changes.length === 0) {
        return JSON.stringify(
          {
            ok: false,
            message: '没有任何字段发生变化，未做修改。请确认要改什么。',
          },
          null,
          2,
        );
      }

      // ── 落库 ───────────────────────────────────────────
      const item = updateItem(db, itemId, {
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(nextSummary !== undefined ? { summary: nextSummary } : {}),
        ...(nextStatus !== undefined ? { status: nextStatus } : {}),
        ...(nextOccurredAt !== undefined ? { occurredAt: nextOccurredAt } : {}),
        data: mergedData,
      });
      if (!item) throw new Error('更新失败');

      // 原话与变更都留痕，entries 只增不改
      appendEntry(db, {
        rawText: reason,
        aiDecision: {
          corrected: itemId,
          affectedType: type?.name ?? null,
          changes: changes.map((change) => `${change.label}: ${change.from} → ${change.to}`),
        },
      });

      // 内容变了，向量必须重算——否则语义检索命中的还是改之前那版信息
      await vectors.indexItem(item.id);

      const fields = labeledFields(type, item);
      const card: MemoryCard = {
        kind: 'corrected',
        itemId: item.id,
        typeName: type?.name ?? '(未知类别)',
        typeIsNew: false,
        title: item.title,
        summary: item.summary ?? undefined,
        status: item.status ?? undefined,
        occurredAt: item.occurredAt ?? undefined,
        fields,
        relationCount: 0,
        changes,
      };

      return withCard(
        {
          ok: true,
          itemId: item.id,
          changedFields: changes.map((change) => change.label),
          nextStep: '已修正并在界面回显卡片。正文一句话确认即可，不要复述字段。',
        },
        card,
      );
    },
  };
}

function labeledFields(type: ItemType | null, item: Item): MemoryCardField[] {
  const labelOf = new Map((type?.fields ?? []).map((field) => [field.key, field.label]));
  const fields = Object.entries(item.data ?? {}).map(([key, value]) => ({
    label: labelOf.get(key) ?? key,
    value: displayValue(value),
  }));
  if (item.status) fields.push({ label: '状态', value: item.status });
  return fields;
}

function formatDay(timestamp: number | null | undefined): string {
  if (!timestamp) return '(空)';
  return new Date(timestamp).toISOString().slice(0, 10);
}