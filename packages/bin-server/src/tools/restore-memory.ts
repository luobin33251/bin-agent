import {
  appendEntry,
  getDatabase,
  getTypeById,
  listItems,
  restoreItem,
  type Item,
  type ItemType,
} from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';
import { asString, displayValue } from './params.js';
import { withCard, type MemoryCard, type MemoryCardField } from './memory-card.js';

/**
 * 恢复一条被删除的记录。
 *
 * 存在的意义是让「软删除」这套设计真正成立——如果删了就没法回来，
 * 软删除就只是"看不见的硬删除"，白留了一堆数据。
 *
 * 恢复需要 item_id，而删除后的记录不在任何检索结果里，
 * 所以这个工具的正常用法是：用户说"把刚才删的 XX 恢复回来"，
 * 模型从对话上下文里拿 id；拿不到就说明是哪个，由用户重新告知。
 */
export function createRestoreMemoryTool(deps: { vectors: MemoryVectors }): Tool {
  const { vectors } = deps;

  return {
    name: 'restore_memory',
    description:
      '恢复一条被删除的记录。用户说「撤销删除」「把刚才删的那条找回来」时使用。' +
      '如果对话上下文里没有那条记录的 id，先用 search_memory 查——' +
      '注意已删除的记录不会被 search_memory 检索到，所以拿不到 id 时请直接问用户是哪一条。',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '要恢复的条目 id' },
        reason: {
          type: 'string',
          description: '用户要求恢复的原话，原样复制。会永久留存。',
        },
      },
      required: ['item_id', 'reason'],
    },

    async execute(params) {
      const db = getDatabase();
      const itemId = asString(params.item_id);
      const reason = asString(params.reason);

      if (!itemId) throw new Error('item_id 不能为空');
      if (!reason) throw new Error('reason 不能为空：必须说明用户为什么要求恢复');

      const item = restoreItem(db, itemId);
      if (!item) {
        return JSON.stringify(
          {
            ok: false,
            message: `没有恢复：找不到 id 为 ${itemId} 的已删除记录（可能 id 不对，或者这条从未被删除）。`,
            nextStep: '不要向用户声称已经恢复，先确认是哪一条记录。',
          },
          null,
          2,
        );
      }

      // 恢复后同一类别里可能又有重复了，顺手提示一下
      const siblings = listItems(db, { typeId: item.typeId, limit: 300 });
      const duplicateHint =
        siblings.length > 1 ? `该类别现有 ${siblings.length} 条记录，注意检查是否又出现重复。` : undefined;

      appendEntry(db, {
        rawText: reason,
        aiDecision: { restored: itemId, restoredTitle: item.title },
      });

      // 删除时向量被一起摘了，恢复得补回来——仓储层的 restoreItem 只能重建全文索引，
      // 向量要调嵌入接口，做不到同步
      await vectors.indexItem(item.id);

      const type = getTypeById(db, item.typeId);
      const card: MemoryCard = {
        kind: 'restored',
        itemId: item.id,
        typeName: type?.name ?? '(未知类别)',
        typeIsNew: false,
        title: item.title,
        summary: item.summary ?? undefined,
        fields: labeledFields(type, item),
        relationCount: 0,
      };

      return withCard(
        {
          ok: true,
          restoredItemId: item.id,
          ...(duplicateHint ? { duplicateHint } : {}),
          nextStep: '已恢复并在界面回显卡片。正文一句话确认即可。',
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