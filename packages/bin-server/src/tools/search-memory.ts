import {
  countItems,
  countTypes,
  getDatabase,
  searchItems,
  searchTypes,
  type Db,
  type ItemSearchHit,
} from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';
import { asNumber, asString, displayValue } from './params.js';

/**
 * 检索已有记忆：既是「写入前先看能不能复用已有类别」的入口，
 * 也是「回答用户提问时把相关条目找出来」的入口。
 *
 * 条目走**关键词 + 语义的混合检索**（RRF 融合）：
 * 用户问「上次那个空调的事」时，措辞往往和记录时不一致，
 * 纯关键词那路会整片落空，语义那路才救得回来。
 * 类别仍然只按名称匹配——类别数量少、命名也由模型统一生成，语义那路帮助有限，
 * 不值得再给类别维护一套向量。
 */
export function createSearchMemoryTool(deps: { vectors: MemoryVectors }): Tool {
  const { vectors } = deps;

  return {
    name: 'search_memory',
    description:
      '检索已有记录。可用于两件事：一是写入任何新信息之前，先查已有类别，能归进去就不要新建（避免类别越分越碎）；' +
      '二是用户问起以前记过的事时，把相关条目找出来。' +
      'query 用用户话里最关键的说法即可，支持语义匹配，不要求字面一致；留空则返回全部已有类别清单。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词，用用户话里最关键的词。留空表示「列出全部类别」。',
        },
        scope: {
          type: 'string',
          enum: ['all', 'types', 'items'],
          description: '检索范围：types 只查类别，items 只查条目，默认 all',
        },
        limit: {
          type: 'number',
          description: '每类最多返回多少条，默认 10',
        },
      },
      required: [],
    },

    async execute(params) {
      const db = getDatabase();
      const query = asString(params.query);
      const scope = asString(params.scope, 'all') as 'all' | 'types' | 'items';
      const limit = asNumber(params.limit) ?? 10;

      const wantTypes = scope === 'all' || scope === 'types';
      const wantItems = scope === 'all' || scope === 'items';

      // 语义那一路要先给查询文本求向量。失败（没配 Key、网络问题）就当没有，
      // 检索退化成纯关键词——降级可以，直接报错不行，否则一次网络抖动就让模型没法查东西。
      const queryVector = wantItems && query ? await vectors.embedQuery(query) : null;

      const types = wantTypes ? searchTypes(db, query).slice(0, limit) : [];
      const items = wantItems
        ? searchItems(db, query, {
            limit,
            queryVector,
            vectorModel: vectors.ready ? vectors.model : undefined,
          })
        : [];

      const searchMode: 'hybrid' | 'keyword-only' = queryVector ? 'hybrid' : 'keyword-only';

      // 无论本次查什么范围，都告诉模型「库里总共有多少东西」。
      // 这一点很关键：早先版本在 scope=types 时返回 totalItems: 0（因为压根没查条目），
      // 模型看到 0 就断定「系统里什么都没记」，然后向用户道歉说自己没存——
      // 而数据其实好好地在库里。命中数会和总量被混为一谈，必须分开表达。
      const librarySummary = {
        typesTotal: countTypes(db),
        itemsTotal: countItems(db),
        note: '这是库里当前的总量，与本次查询命中的条数无关',
      };

      const payload: Record<string, unknown> = {
        query: query || '(全部)',
        scope,
        librarySummary,
        // null 表示「本次没有查这个范围」，不要用 0 —— 0 会被误读成「一条都没有」
        matchedTypes: wantTypes ? types.length : null,
        matchedItems: wantItems ? items.length : null,
        searchMode,
      };

      // 没配嵌入 Key 时语义那一路是关的，得让模型知道，
      // 否则它会把「关键词没匹配上」当成「库里没有」，或者反向吹嘘自己能理解意思
      if (wantItems && !vectors.ready) {
        payload.searchModeNote = '语义检索未启用（未配置嵌入模型），本次仅按关键词匹配，换更贴近原话的说法可能有用。';
      }

      if (wantTypes) {
        payload.types = types.map((type) => ({
          id: type.id,
          name: type.name,
          description: type.description,
          status: type.status,
          usageCount: type.usageCount,
          itemCount: countItems(db, type.id),
          fields: type.fields.map((field) => `${field.key}(${field.label}${field.type ? `:${field.type}` : ''})`),
        }));
      }

      if (wantItems) {
        payload.items = items.map((hit) => describeItem(db, hit));
        // 命中了不等于相关：相似度 0.42 和 0.8 都过下限，但含义差得远。
        // 把最高分单独拎出来，模型一眼就能看出「这一批是不是都只是勉强沾边」
        const scores = items
          .map((hit) => hit.semanticScore)
          .filter((score): score is number => score !== null);
        if (scores.length > 0) {
          payload.topSimilarity = Number(Math.max(...scores).toFixed(3));
          payload.similarityGuide =
            '0.5 以上算比较确定相关；0.4~0.5 只是勉强沾边。' +
            '如果 topSimilarity 只有 0.4 出头，说明没有真正相关的记录，应当如实说没找到。';
        }
      }

      // 命中为空时把话说清楚，避免模型把「没搜到」理解成「库里没有」
      const libraryEmpty = librarySummary.typesTotal === 0 && librarySummary.itemsTotal === 0;
      if (types.length === 0 && items.length === 0) {
        payload.note = libraryEmpty
          ? '库里目前是空的，还没有任何类别和条目，需要由你判断并新建一个类别。'
          : '本次没有匹配到任何记录。注意：这只是「没搜到」，不代表库里没有相关内容——' +
            '换一个更贴近用户原话的关键词再试一次，或者直接把库里已有的类别列给用户看。';
      }

      return JSON.stringify(payload, null, 2);
    },
  };
}

function describeItem(db: Db, hit: ItemSearchHit) {
  const item = hit.item;
  const typeRow = db.prepare('SELECT name FROM type_defs WHERE id = ?').get(item.typeId) as
    | { name: string }
    | undefined;

  return {
    id: item.id,
    typeName: typeRow?.name ?? '(未知类别)',
    title: item.title,
    summary: item.summary,
    status: item.status,
    occurredAt: item.occurredAt ? new Date(item.occurredAt).toISOString().slice(0, 10) : null,
    data: Object.fromEntries(
      Object.entries(item.data ?? {}).map(([key, value]) => [key, displayValue(value)]),
    ),
    // 语义相似度，纯关键词命中时没有这一项
    ...(hit.semanticScore !== null ? { similarity: Number(hit.semanticScore.toFixed(3)) } : {}),
    matchedBy: hit.sources,
    createdAt: new Date(item.createdAt).toISOString(),
  };
}