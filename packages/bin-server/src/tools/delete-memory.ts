import {
  appendEntry,
  deleteItem,
  getDatabase,
  getItemById,
  getTypeById,
  type Item,
  type ItemType,
} from '@bin/db';
import type { Tool } from '@bin/core';
import { asString, displayValue } from './params.js';
import { withCard, type MemoryCard, type MemoryCardField } from './memory-card.js';

/**
 * 删除一条记忆。
 *
 * 底层是**软删除**：数据行保留，只打 deleted_at 标记，并摘掉全文索引与向量索引。
 * 这样做是因为删除不可逆，而这是一套「记忆」系统——误删的代价远高于留一行数据。
 * 误删了可以用 restore_memory 找回来（恢复时会重新补算向量）。
 *
 * 提示词里另有约束：只有用户明确要求删除时才允许调用。
 */
export function createDeleteMemoryTool(): Tool {
  return {
    name: 'delete_memory',
    description:
      '删除一条记录。**只有用户明确要求删除某条记录时才调用**，不要自作主张删——' +
      '重复的记录应该用 merge_memory 合并，而不是删掉其中一条。' +
      '调用前如果拿不准是哪一条，先用 search_memory 确认。',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '要删除的条目 id' },
        reason: {
          type: 'string',
          description: '用户要求删除的原话，原样复制。会永久留存，用于日后追溯。',
        },
      },
      required: ['item_id', 'reason'],
    },

    async execute(params) {
      const db = getDatabase();
      const itemId = asString(params.item_id);
      const reason = asString(params.reason);

      if (!itemId) throw new Error('item_id 不能为空');
      if (!reason) throw new Error('reason 不能为空：必须说明用户为什么要求删除');

      const item = getItemById(db, itemId);
      if (!item) throw new Error(`找不到 id 为 ${itemId} 的记录，请先用 search_memory 确认`);

      const type = getTypeById(db, item.typeId);
      deleteItem(db, itemId);

      appendEntry(db, {
        rawText: reason,
        aiDecision: {
          deleted: itemId,
          deletedTitle: item.title,
          affectedType: type?.name ?? null,
          // 留一份快照，将来若要恢复或追溯，能看出删掉的是什么
          snapshot: {
            title: item.title,
            summary: item.summary,
            status: item.status,
            data: item.data,
          },
        },
      });

      const card: MemoryCard = {
        kind: 'deleted',
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
          deletedItemId: item.id,
          nextStep: '已删除并在界面回显卡片。正文一句话确认即可，不要复述字段。',
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