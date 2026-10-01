import {
  appendEntry,
  countItems,
  createItem,
  createLink,
  createType,
  findSimilarItems,
  findTypeByName,
  getDatabase,
  getItemById,
  incrementTypeUsage,
  type ItemType,
  type TypeFieldDef,
  type TypeFieldType,
} from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';
import {
  asBoolean,
  asNumber,
  asOptionalString,
  asRecordArray,
  asString,
  displayValue,
  parseDate,
} from './params.js';
import { withCard, type MemoryCard, type MemoryCardField } from './memory-card.js';

const FIELD_TYPES: TypeFieldType[] = ['text', 'number', 'date', 'boolean', 'enum', 'json'];

/**
 * 写入一条记忆。
 *
 * 内部自动处理「新建类别还是复用已有类别」——这是刻意的：
 * 如果把「建类别」和「写条目」拆成两个工具，模型要在一轮里做两次决策、
 * 多发一次请求，而且很容易在复用判断上偷懒导致类别碎片化。
 * 放在一个工具里，"先查后写"就变成了不可绕过的服务端逻辑。
 */
export function createSaveMemoryTool(deps: { vectors: MemoryVectors }): Tool {
  const { vectors } = deps;

  return {
    name: 'save_memory',
    description:
      '把用户说的信息归类并存下来。调用前应当先用 search_memory 看过已有类别。' +
      '类别名要复用已有的叫法；只有确实归不进任何已有类别时才新建。' +
      '如果用户一句话里包含多件独立的事，应该分别调用多次，不要硬塞进一条。',
    parameters: {
      type: 'object',
      properties: {
        type_name: {
          type: 'string',
          description: '类别名，如「待办事项」「读书心得」「采购跟进」。优先复用已有类别的叫法。',
        },
        type_description: {
          type: 'string',
          description: '类别的语义说明，供以后判断能否复用。仅新建类别时需要。',
        },
        type_fields: {
          type: 'array',
          description:
            '该类别的字段定义。仅新建类别时需要，且要一次给全——类别建好后很难再补字段。',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '字段标识，英文小驼峰，如 amount' },
              label: { type: 'string', description: '中文字段名，如 金额' },
              type: {
                type: 'string',
                enum: ['text', 'number', 'date', 'boolean', 'enum', 'json'],
                description: '字段类型，默认 text',
              },
              options: {
                type: 'array',
                items: { type: 'string', description: '一个可选值' },
                description:
                  'type 为 enum 时的全部可选值。「发票状态」「状态」这类取值有限的字段务必用 enum 并在这里列全，' +
                  '否则以后同类记录会写出五花八门的值（「已开」「已开票」「已开票报销」），导致没法聚合统计。',
              },
              description: { type: 'string', description: '该字段填什么，帮助以后填写时保持一致' },
            },
            required: ['key', 'label'],
          },
        },
        title: {
          type: 'string',
          description: '这条记录的标题，一句话说清是什么事，便于列表展示和检索。',
        },
        summary: {
          type: 'string',
          description: '一句话摘要，可选。用于检索命中后的快速浏览。',
        },
        data: {
          type: 'array',
          description: '从用户话里提取出的字段，key 必须落在该类别已定义的 fields 上。',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '字段标识，与类别定义一致' },
              label: { type: 'string', description: '字段中文名' },
              value: { type: 'string', description: '字段值' },
            },
            required: ['key', 'label', 'value'],
          },
        },
        status: {
          type: 'string',
          description: '状态值，如「待办」「进行中」「已完结」。类别语义需要时才给。',
        },
        occurred_at: {
          type: 'string',
          description: '事情发生的时间，ISO 格式如 2026-07-10。不是录入时间。提到具体日期时必给。',
        },
        entry_text: {
          type: 'string',
          description:
            '用户这次说的原话，原样复制不要改写。这份原话会永久留存，用于日后追溯和重新归类。',
        },
        confidence: {
          type: 'number',
          description: '你对这次归类的把握，0 到 1 之间。拿不准就给低分，系统会提示用户确认。',
        },
        relations: {
          type: 'array',
          description: '与已有条目建立关联。目标 id 从 search_memory 的结果里取。',
          items: {
            type: 'object',
            properties: {
              target_item_id: { type: 'string', description: '目标条目的 id' },
              relation: { type: 'string', description: '关系名，如「来源于」「催办」「属于」' },
              note: { type: 'string', description: '补充说明' },
            },
            required: ['target_item_id', 'relation'],
          },
        },
        confirm_duplicate: {
          type: 'boolean',
          description:
            '仅在系统返回疑似重复、且用户确认这确实是两笔独立记录时才传 true。' +
            '不要在一开始就传，否则查重保护等于失效。',
        },
      },
      required: ['type_name', 'title', 'entry_text'],
    },

    async execute(params) {
      const db = getDatabase();

      const typeName = asString(params.type_name);
      const title = asString(params.title);
      const entryText = asString(params.entry_text);

      if (!typeName) throw new Error('type_name 不能为空');
      if (!title) throw new Error('title 不能为空');
      if (!entryText) throw new Error('entry_text 不能为空：必须原样带上用户的原话');

      const typeFields = asRecordArray(params.type_fields).map(toFieldDef).filter(isFieldDef);
      const pairs = asRecordArray(params.data).map((row) => ({
        key: asString(row.key) || asString(row.label),
        label: asString(row.label) || asString(row.key),
        value: displayValue(row.value),
      }));
      const occurredAt = parseDate(params.occurred_at);
      const confidence = asNumber(params.confidence);
      const status = asOptionalString(params.status);

      // ── 1. 类别：复用优先 ────────────────────────────────
      let typeRow: ItemType | null = findTypeByName(db, typeName);
      let typeIsNew = false;

      if (!typeRow) {
        typeRow = createType(db, {
          name: typeName,
          description: asOptionalString(params.type_description) ?? null,
          fields: typeFields,
          // 已被真实条目使用，所以直接是 active；draft 留给"AI 建议但尚无条目"的场景
          status: 'active',
          createdBy: 'ai',
        });

        if (typeRow) {
          typeIsNew = true;
        } else {
          // createType 在同名冲突时返回 null，说明期间已有同名类别，退回复用
          typeRow = findTypeByName(db, typeName);
        }
      }

      if (!typeRow) throw new Error(`类别「${typeName}」既未能创建也未能复用`);

      const data = Object.fromEntries(pairs.map((pair) => [pair.key, pair.value]));

      // ── 2. 查重 ────────────────────────────────────────
      // 挡在落库之前：模型对"这条是不是已经记过"的判断并不可靠，
      // 实测出现过同一件事被记两遍（标题不同、字段和日期完全一致），
      // 而它发现问题后没有合并工具，只能口头说"我来合并清理"，等于什么都没做。
      if (!asBoolean(params.confirm_duplicate)) {
        const similar = findSimilarItems(db, {
          typeId: typeRow.id,
          data,
          occurredAt: occurredAt ?? null,
        });

        if (similar.length > 0) {
          return JSON.stringify(
            {
              ok: false,
              suspectedDuplicate: similar.map((item) => ({
                id: item.id,
                title: item.title,
                summary: item.summary,
                status: item.status,
              })),
              message:
                '没有写入：该类别下已存在发生时间相同、且有多个字段值完全一致的记录，很可能是同一件事。',
              nextStep:
                '不要向用户声称已经记录。先告诉用户「这条之前好像已经记过了」，并复述已有记录让他确认。' +
                '如果用户确认这确实是两笔独立的记录，再带上 confirm_duplicate=true 重新调用。',
            },
            null,
            2,
          );
        }
      }

      // 计数放在查重之后：被判定为重复而没有落库的，不该算作一次使用
      incrementTypeUsage(db, typeRow.id);

      // ── 3. 原话（不可变）────────────────────────────────
      const entry = appendEntry(db, {
        rawText: entryText,
        aiDecision: {
          typeName: typeRow.name,
          typeIsNew,
          title,
          fields: pairs.map((pair) => `${pair.label}=${pair.value}`),
          confidence: confidence ?? null,
        },
      });

      // ── 4. 条目 ────────────────────────────────────────
      const item = createItem(db, {
        typeId: typeRow.id,
        title,
        summary: asOptionalString(params.summary) ?? null,
        data,
        status: status ?? null,
        occurredAt: occurredAt ?? null,
        confidence: confidence ?? null,
        sourceEntryId: entry.id,
      });

      // ── 5. 关联 ────────────────────────────────────────
      let relationCount = 0;
      for (const row of asRecordArray(params.relations)) {
        const targetId = asString(row.target_item_id);
        const relation = asString(row.relation);
        if (!targetId || !relation) continue;
        if (!getItemById(db, targetId)) continue; // 目标不存在就跳过，不让整次写入失败
        createLink(db, {
          fromItemId: item.id,
          toItemId: targetId,
          relation,
          note: asOptionalString(row.note) ?? null,
        });
        relationCount += 1;
      }

      // ── 6. 向量 ────────────────────────────────────────
      // 放在落库之后、卡片之前：这是唯一会走网络的步骤，
      // 失败不能影响这次写入——数据已经在库里了，只是暂时只能靠关键词找到它。
      await vectors.indexItem(item.id);

      // ── 7. 回显卡片 ────────────────────────────────────
      const cardFields: MemoryCardField[] = pairs.map((pair) => ({
        label: pair.label,
        value: pair.value,
      }));
      if (status) cardFields.push({ label: '状态', value: status });

      const card: MemoryCard = {
        kind: 'saved',
        itemId: item.id,
        typeName: typeRow.name,
        typeIsNew,
        title: item.title,
        summary: item.summary ?? undefined,
        status: status ?? undefined,
        occurredAt: occurredAt ?? undefined,
        fields: cardFields,
        relationCount,
        confidence: confidence ?? undefined,
      };

      return withCard(
        {
          ok: true,
          itemId: item.id,
          typeName: typeRow.name,
          typeIsNew,
          typeItemCount: countItems(db, typeRow.id),
          relationCount,
          // 提醒模型：卡片已经把字段展示给用户了，正文别重复念一遍
          nextStep: '已入库并在界面回显卡片。正文只需一句话确认，不要复述卡片里的字段。',
        },
        card,
      );
    },
  };
}

function toFieldDef(row: Record<string, unknown>): TypeFieldDef | null {
  const key = asString(row.key);
  const label = asString(row.label) || key;
  if (!key) return null;

  const rawType = asString(row.type, 'text') as TypeFieldType;
  const type = FIELD_TYPES.includes(rawType) ? rawType : 'text';

  // 枚举值必须一起带上：丢了它，同类记录的同一字段就会各写各的，没法聚合
  const options = Array.isArray(row.options)
    ? row.options.map((option) => asString(option)).filter(Boolean)
    : undefined;

  return {
    key,
    label,
    type,
    ...(type === 'enum' && options && options.length > 0 ? { options } : {}),
    description: asOptionalString(row.description),
  };
}

function isFieldDef(value: TypeFieldDef | null): value is TypeFieldDef {
  return value !== null;
}