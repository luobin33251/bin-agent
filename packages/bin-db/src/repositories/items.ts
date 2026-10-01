import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';
import { fuseRanked, type MatchSource } from '../search/hybrid.js';
import { indexObject, removeFromIndex, searchIndex } from '../search/index.js';
import { removeVector, searchVectors } from '../search/vector.js';

export interface Item {
  id: string;
  typeId: string;
  title: string;
  summary: string | null;
  data: Record<string, unknown>; // 字段随类型变化，不做固定列
  status: string | null;
  occurredAt: number | null; // 事情发生的时间，可能早于录入时间
  confidence: number | null; // AI 归类置信度，低于阈值的可提示用户确认
  sourceEntryId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 非 null 表示已软删除：数据仍在，但从所有查询与索引里消失 */
  deletedAt: number | null;
}

interface ItemRow {
  id: string;
  type_id: string;
  title: string;
  summary: string | null;
  data: string;
  status: string | null;
  occurred_at: number | null;
  confidence: number | null;
  source_entry_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    typeId: row.type_id,
    title: row.title,
    summary: row.summary,
    data: safeParse(row.data),
    status: row.status,
    occurredAt: row.occurred_at,
    confidence: row.confidence,
    sourceEntryId: row.source_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface CreateItemInput {
  typeId: string;
  title: string;
  summary?: string | null;
  data?: Record<string, unknown>;
  status?: string | null;
  occurredAt?: number | null;
  confidence?: number | null;
  sourceEntryId?: string | null;
}

export function createItem(db: Db, input: CreateItemInput): Item {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO items
       (id, type_id, title, summary, data, status, occurred_at, confidence, source_entry_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.typeId,
    input.title,
    input.summary ?? null,
    JSON.stringify(input.data ?? {}),
    input.status ?? null,
    input.occurredAt ?? null,
    input.confidence ?? null,
    input.sourceEntryId ?? null,
    now,
    now,
  );

  const item = getItemById(db, id)!;
  syncItemIndex(db, item);
  return item;
}

/**
 * 拼出用于检索的文本。
 *
 * 拼进来的字段越多，检索越容易命中，但噪声也越大——只取标题、摘要、类别名和字段值。
 * 同一份文本既喂 FTS 索引，也喂向量嵌入：两路检索看到的内容必须一致，
 * 否则会出现「关键词能找到、语义找不到」这种没法解释的行为。
 */
function composeIndexText(db: Db, item: Item): string {
  const typeRow = db
    .prepare('SELECT name FROM type_defs WHERE id = ?')
    .get(item.typeId) as { name: string } | undefined;

  const values = Object.values(item.data ?? {}).map((value) => (value == null ? '' : String(value)));
  return [typeRow?.name, item.title, item.summary, item.status, ...values].filter(Boolean).join(' ');
}

/**
 * 把条目写进全文索引。
 * 放在仓储层而不是工具层，是为了让「忘记同步索引」这件事不可能发生。
 */
function syncItemIndex(db: Db, item: Item): void {
  indexObject(db, item.id, 'item', composeIndexText(db, item));
}

/**
 * 取出某条条目用于嵌入的文本。
 *
 * 向量是异步算的（要走 HTTP），塞不进 SQLite 事务，所以只能由上层拿着这个函数
 * 单独算一次再写回。文本的拼法留在数据层，保证和 FTS 索引用的是同一份。
 */
export function getItemIndexText(db: Db, itemId: string): string | null {
  const item = getItemById(db, itemId);
  return item ? composeIndexText(db, item) : null;
}

export function getItemById(db: Db, id: string): Item | null {
  const row = db
    .prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL')
    .get(id) as ItemRow | undefined;
  return row ? mapItem(row) : null;
}

export interface ListItemsOptions {
  typeId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function listItems(db: Db, options: ListItemsOptions = {}): Item[] {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  if (options.typeId) {
    conditions.push('type_id = ?');
    params.push(options.typeId);
  }
  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit ?? 50, options.offset ?? 0);

  const rows = db
    .prepare(`SELECT * FROM items ${where} ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ? OFFSET ?`)
    .all(...params) as ItemRow[];

  return rows.map(mapItem);
}

export interface UpdateItemInput {
  title?: string;
  summary?: string | null;
  data?: Record<string, unknown>;
  status?: string | null;
  occurredAt?: number | null;
  confidence?: number | null;
}

export function updateItem(db: Db, id: string, patch: UpdateItemInput): Item | null {
  const current = getItemById(db, id);
  if (!current) return null;

  db.prepare(
    `UPDATE items
        SET title = ?, summary = ?, data = ?, status = ?, occurred_at = ?, confidence = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.title ?? current.title,
    patch.summary !== undefined ? patch.summary : current.summary,
    JSON.stringify(patch.data ?? current.data),
    patch.status !== undefined ? patch.status : current.status,
    patch.occurredAt !== undefined ? patch.occurredAt : current.occurredAt,
    patch.confidence !== undefined ? patch.confidence : current.confidence,
    Date.now(),
    id,
  );

  const item = getItemById(db, id)!;
  syncItemIndex(db, item);
  return item;
}

/**
 * 软删除。数据行保留，只打上 deleted_at 并摘掉两个索引（全文 + 向量）。
 * 用软删除而不是 DELETE：删除不可逆，而这套系统的原则是「什么都不真正丢」。
 *
 * 索引必须一起摘：FTS 和向量都是「只有活着的内容才在里面」，
 * 两个索引语义不一致的话，恢复条目时就得靠猜哪个该补。
 */
export function deleteItem(db: Db, id: string): boolean {
  const apply = db.transaction(() => {
    const changes = db
      .prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), Date.now(), id).changes;
    if (changes > 0) {
      removeFromIndex(db, id, 'item');
      removeVector(db, id, 'item');
    }
    return changes > 0;
  });
  return apply();
}

/**
 * 恢复一条被软删除的条目。
 *
 * FTS 索引在这里同步重建（纯本地操作），但向量不行——它要调嵌入接口，
 * 是异步的。所以恢复后这一条暂时只能被关键词检索到，
 * 由调用方（restore_memory 工具）补算一次，漏了也有启动自检兜底。
 */
export function restoreItem(db: Db, id: string): Item | null {
  const apply = db.transaction(() => {
    const changes = db
      .prepare('UPDATE items SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes;
    if (changes === 0) return null;
    const item = getItemById(db, id);
    if (item) syncItemIndex(db, item);
    return item;
  });
  return apply();
}

/**
 * 合并两条条目：保留 target，把 source 并入后软删除。
 *
 * 字段合并策略是「**target 优先，source 只补空缺**」——
 * 用户选择保留哪一条，就意味着那条的值更可信，不能被 source 覆盖。
 * 关联关系全部改挂到 target，冲突的（同一对条目同一关系）由唯一约束挡掉。
 */
export function mergeItems(db: Db, targetId: string, sourceId: string): Item | null {
  if (targetId === sourceId) return null;

  const apply = db.transaction(() => {
    const target = getItemById(db, targetId);
    const source = getItemById(db, sourceId);
    if (!target || !source) return null;

    // target 优先，source 只补 target 的空缺：用户选择保留哪一条，就意味着那条的值更可信
    const filled = (value: unknown) =>
      value !== null && value !== undefined && String(value).trim() !== '';

    const merged: Record<string, unknown> = { ...source.data };
    for (const [key, value] of Object.entries(target.data ?? {})) {
      if (filled(value)) merged[key] = value;
    }

    const now = Date.now();
    db.prepare(
      `UPDATE items
          SET title = ?, summary = COALESCE(summary, ?), data = ?, status = COALESCE(status, ?),
              occurred_at = COALESCE(occurred_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(
      target.title,
      source.summary,
      JSON.stringify(merged),
      source.status,
      source.occurredAt,
      now,
      targetId,
    );

    // 关联改挂：先跳过已存在的同一关系，避免被唯一约束整批拒掉
    const existing = db
      .prepare(
        'SELECT from_item_id, to_item_id, relation FROM links WHERE from_item_id = ? OR to_item_id = ?',
      )
      .all(targetId, targetId) as Array<{ from_item_id: string; to_item_id: string; relation: string }>;
    const existingKeys = new Set(existing.map((l) => `${l.from_item_id}|${l.to_item_id}|${l.relation}`));

    const sourceLinks = db
      .prepare('SELECT * FROM links WHERE from_item_id = ? OR to_item_id = ?')
      .all(sourceId, sourceId) as Array<{
      id: string;
      from_item_id: string;
      to_item_id: string;
      relation: string;
      note: string | null;
      created_at: number;
    }>;

    for (const link of sourceLinks) {
      const from = link.from_item_id === sourceId ? targetId : link.from_item_id;
      const to = link.to_item_id === sourceId ? targetId : link.to_item_id;
      if (to === targetId && from === targetId) continue;
      const key = `${from}|${to}|${link.relation}`;
      if (existingKeys.has(key)) {
        db.prepare('DELETE FROM links WHERE id = ?').run(link.id);
        continue;
      }
      db.prepare('UPDATE links SET from_item_id = ?, to_item_id = ? WHERE id = ?').run(from, to, link.id);
      existingKeys.add(key);
    }

    // source 软删除，两个索引一起摘
    db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, sourceId);
    removeFromIndex(db, sourceId, 'item');
    removeVector(db, sourceId, 'item');

    const result = getItemById(db, targetId);
    if (result) syncItemIndex(db, result);
    return result;
  });

  return apply();
}

export function countItems(db: Db, typeId?: string): number {
  const row = typeId
    ? (db
        .prepare('SELECT COUNT(*) AS c FROM items WHERE type_id = ? AND deleted_at IS NULL')
        .get(typeId) as { c: number })
    : (db.prepare('SELECT COUNT(*) AS c FROM items WHERE deleted_at IS NULL').get() as { c: number });
  return row.c;
}

export interface SearchItemsOptions {
  limit?: number;
  /**
   * 查询向量。传了就走混合检索，不传（或传空）就只有关键词那一路。
   *
   * 由调用方算好传进来，而不是在数据层调嵌入接口：
   * 数据层保持纯同步，才能被放进事务、被单测直接调用。
   */
  queryVector?: readonly number[] | null;
  /** 与向量配套的模型名，必须和写入时一致，否则查不到 */
  vectorModel?: string;
  vectorMinScore?: number;
}

export interface ItemSearchHit {
  item: Item;
  /** 这条是被哪几路召回的，便于排查「它为什么排这么前」 */
  sources: MatchSource[];
  /** RRF 融合分。只用于排序，量纲没有直观含义，不要给用户看 */
  fusionScore: number;
  /**
   * 语义相似度（0~1）。null 表示这条是纯关键词命中的，压根没算过语义分。
   *
   * 之所以要把它透出去：下限只是一道粗过滤，0.42 和 0.8 都「过线」，
   * 但前者只是勉强沾边。让调用方（模型）看到分数，它才能判断
   * 「命中的最高分才 0.4 出头」时该如实说没找到真正相关的，而不是挑一条硬答。
   */
  semanticScore: number | null;
}

/**
 * 检索条目：关键词（FTS5）与语义（向量）两路，用 RRF 融合后返回。
 *
 * 两路召回的互补性很明确：用户说「上次那个空调的事」时，
 * 关键词那路可能因为措辞不同而全落空，语义那路才救得回来；
 * 反过来问某个编号、人名时，关键词精确得多。
 */
export function searchItems(
  db: Db,
  query: string,
  options: SearchItemsOptions = {},
): ItemSearchHit[] {
  const limit = options.limit ?? 20;

  const keywordHits = query.trim() ? searchIndex(db, query, { limit, kind: 'item' }) : [];

  const semanticHits =
    options.queryVector && options.queryVector.length > 0 && options.vectorModel
      ? searchVectors(db, options.queryVector, {
          model: options.vectorModel,
          kind: 'item',
          limit,
          minScore: options.vectorMinScore,
        })
      : [];

  const semanticScoreById = new Map(semanticHits.map((hit) => [hit.objId, hit.score]));

  const fused = fuseRanked(
    [
      { source: 'keyword' as const, hits: keywordHits },
      { source: 'semantic' as const, hits: semanticHits },
    ],
    { limit },
  );
  if (fused.length === 0) return [];

  // 融合结果里可能混着已软删除的条目（向量摘除失败、或删了又恢复过），
  // 所以按 id 取回时必须重新过滤一遍，顺序仍按融合名次
  const placeholders = fused.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM items WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...fused.map((hit) => hit.objId)) as ItemRow[];

  const byId = new Map(rows.map((row) => [row.id, mapItem(row)]));
  const results: ItemSearchHit[] = [];

  for (const hit of fused) {
    const item = byId.get(hit.objId);
    if (!item) continue;
    results.push({
      item,
      sources: hit.sources,
      fusionScore: hit.score,
      semanticScore: semanticScoreById.get(hit.objId) ?? null,
    });
  }

  return results;
}

/**
 * 查重：在同一类别下找出与原条目高度重合的已有记录。
 *
 * 判定规则刻意保守——**同类别 + 发生时间相同 + 至少两个非空字段值一致**。
 * 只看标题相似度是抓不到的：实际出现过「王工PDA采购（6台）」和
 * 「10月7日发起6台PDA采购」这种标题差异很大、字段却完全一致的情况。
 *
 * 保守是为了避免误拦：真实的两笔相同采购（同一天买两批同样的东西）
 * 在字段上会完全一致，此时应由调用方确认后再写入。
 */
export function findSimilarItems(
  db: Db,
  input: { typeId: string; data: Record<string, unknown>; occurredAt?: number | null },
): Item[] {
  const pairs = Object.entries(input.data ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && String(value).trim() !== '',
  );
  if (pairs.length < 2) return [];

  const candidates = listItems(db, { typeId: input.typeId, limit: 300 });

  return candidates.filter((item) => {
    if ((item.occurredAt ?? null) !== (input.occurredAt ?? null)) return false;
    const hits = pairs.filter(([key, value]) => {
      const existing = item.data?.[key];
      return existing !== null && existing !== undefined && String(existing) === String(value);
    });
    return hits.length >= 2;
  });
}