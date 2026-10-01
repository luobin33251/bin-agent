import {
  appendEntry,
  getDatabase,
  getItemById,
  getTypeById,
  listLinksFor,
  mergeItems,
  type Item,
  type ItemType,
} from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';
import { asString, displayValue } from './params.js';
import { withCard, type MemoryCard, type MemoryCardField } from './memory-card.js';

/**
 * 合并两条重复记录。
 *
 * 这是处理「同一件事被记了两遍」的正确做法——比删掉其中一条好，
 * 因为两条记录往往各有一半信息（一条有金额、一条有日期），删掉哪条都丢东西。
 *
 * 合并策略：保留 target，source 的字段只补 target 的空缺，然后 source 被软删除。
 * 用户选择保留哪一条，就意味着那条的值更可信，不能被 source 覆盖。
 */
export function createMergeMemoryTool(deps: { vectors: MemoryVectors }): Tool {
  const { vectors } = deps;

  return {
    name: 'merge_memory',
    description:
      '把两条重复的记录合并成一条。当发现同一件事被记了多次、或者用户说「这两条是一个事」时使用。' +
      '合并后只保留 target_item_id 那条，另一条被并入后移除；两条的字段会自动取长补短。' +
      '**合并前必须先向用户确认要保留哪一条**，不要自己决定。',
    parameters: {
      type: 'object',
      properties: {
        target_item_id: {
          type: 'string',
          description: '要保留的那条记录的 id。它的字段值优先，不会被另一条覆盖。',
        },
        source_item_id: {
          type: 'string',
          description: '要被并入并移除的那条记录的 id。它独有的字段值会补进保留的那条。',
        },
        reason: {
          type: 'string',
          description: '用户说明合并原因的原话，原样复制。会永久留存。',
        },
      },
      required: ['target_item_id', 'source_item_id', 'reason'],
    },

    async execute(params) {
      const db = getDatabase();
      const targetId = asString(params.target_item_id);
      const sourceId = asString(params.source_item_id);
      const reason = asString(params.reason);

      if (!targetId) throw new Error('target_item_id 不能为空');
      if (!sourceId) throw new Error('source_item_id 不能为空');
      if (!reason) throw new Error('reason 不能为空：必须说明为什么合并');
      if (targetId === sourceId) throw new Error('两条记录的 id 相同，无需合并');

      const target = getItemById(db, targetId);
      const source = getItemById(db, sourceId);
      if (!target) throw new Error(`找不到要保留的记录 ${targetId}`);
      if (!source) throw new Error(`找不到要合并掉的记录 ${sourceId}`);

      if (target.typeId !== source.typeId) {
        throw new Error(
          `两条记录属于不同类别（${target.typeId} / ${source.typeId}），不能直接合并。请先确认是不是同一类事。`,
        );
      }

      const before = target.data ?? {};
      const merged = mergeItems(db, targetId, sourceId);
      if (!merged) throw new Error('合并失败');

      // 列出实际补进来的字段，让用户看得见"合并不是简单丢弃"
      const filledIn: string[] = [];
      for (const [key, value] of Object.entries(merged.data ?? {})) {
        const wasEmpty = before[key] === undefined || String(before[key] ?? '').trim() === '';
        if (wasEmpty && String(value ?? '').trim() !== '') filledIn.push(`${key}=${displayValue(value)}`);
      }

      appendEntry(db, {
        rawText: reason,
        aiDecision: {
          merged: { kept: targetId, removed: sourceId },
          keptTitle: target.title,
          removedTitle: source.title,
          filledIn,
          removedSnapshot: { title: source.title, data: source.data, status: source.status },
        },
      });

      // 保留的那条内容变了（补进来了字段），向量要跟着更新
      await vectors.indexItem(merged.id);

      const type = getTypeById(db, merged.typeId);
      const card: MemoryCard = {
        kind: 'merged',
        itemId: merged.id,
        typeName: type?.name ?? '(未知类别)',
        typeIsNew: false,
        title: merged.title,
        summary: merged.summary ?? undefined,
        fields: labeledFields(type, merged),
        relationCount: listLinksFor(db, merged.id).length,
        mergedFrom: source.title,
      };

      return withCard(
        {
          ok: true,
          keptId: merged.id,
          removedId: sourceId,
          filledInFields: filledIn,
          nextStep: '已合并并在界面回显卡片。正文一句话确认即可，不要复述字段。',
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