import type { Db } from '../client.js';

export type IndexKind = 'item' | 'asset' | 'entry';

export interface SearchHit {
  objId: string;
  objKind: string;
}

/**
 * 写入或更新全文索引。
 *
 * search_index 是独立 FTS5 表（不是 external content 表），所以没有触发器自动同步，
 * 由仓储层在写入时显式调用——这样能同时索引条目、文件抽取文本、录入原话三种来源。
 * 先按 obj_id 清旧行再插，保证重复写入不会累积脏数据。
 */
export function indexObject(db: Db, objId: string, objKind: IndexKind, text: string): void {
  const normalized = text.replace(/\s+/g, ' ').trim();

  const apply = db.transaction(() => {
    db.prepare('DELETE FROM search_index WHERE obj_id = ? AND obj_kind = ?').run(objId, objKind);
    if (normalized) {
      db.prepare('INSERT INTO search_index (obj_id, obj_kind, text) VALUES (?, ?, ?)').run(
        objId,
        objKind,
        normalized,
      );
    }
  });

  apply();
}

export function removeFromIndex(db: Db, objId: string, objKind?: IndexKind): void {
  if (objKind) {
    db.prepare('DELETE FROM search_index WHERE obj_id = ? AND obj_kind = ?').run(objId, objKind);
  } else {
    db.prepare('DELETE FROM search_index WHERE obj_id = ?').run(objId);
  }
}

/**
 * 检索索引。
 *
 * 两路并用而不是只用 FTS：trigram 分词器按三字滑窗建索引，
 * 少于 3 个字符的查询（比如「空调」「合同」）切不出 token，MATCH 必然落空。
 * 所以短词走 LIKE 兜底，长词两路合并、FTS 命中优先。
 *
 * FTS 那一路按 rank（bm25）排序而不是默认的 rowid 顺序：
 * 融合层 RRF 只看名次，名次错了融合结果就跟着错——默认顺序接近「写入先后」，
 * 跟相关性无关，会让一条刚写进去的边角记录排到真正相关的那条前面。
 */
export function searchIndex(
  db: Db,
  query: string,
  options: { limit?: number; kind?: IndexKind } = {},
): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 30;
  const kindClause = options.kind ? 'AND obj_kind = ?' : '';
  const kindParams: unknown[] = options.kind ? [options.kind] : [];

  const ftsHits =
    trimmed.length >= 3
      ? (db
          .prepare(
            `SELECT obj_id AS objId, obj_kind AS objKind FROM search_index
              WHERE search_index MATCH ? ${kindClause} ORDER BY rank LIMIT ?`,
          )
          .all(`"${trimmed.replace(/"/g, '""')}"`, ...kindParams, limit) as SearchHit[])
      : [];

  // LIKE 需要转义通配符，否则用户输入的 % 会变成任意匹配
  const likePattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const likeHits = db
    .prepare(
      `SELECT obj_id AS objId, obj_kind AS objKind FROM search_index
        WHERE text LIKE ? ESCAPE '\\' ${kindClause} LIMIT ?`,
    )
    .all(likePattern, ...kindParams, limit) as SearchHit[];

  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const hit of [...ftsHits, ...likeHits]) {
    const key = `${hit.objKind}:${hit.objId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }

  return merged.slice(0, limit);
}

/** 索引里的对象总数，用于启动自检 */
export function countIndexed(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM search_index').get() as { c: number };
  return row.c;
}