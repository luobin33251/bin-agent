import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

export interface Link {
  id: string;
  fromItemId: string;
  toItemId: string;
  relation: string;
  note: string | null;
  createdAt: number;
}

interface LinkRow {
  id: string;
  from_item_id: string;
  to_item_id: string;
  relation: string;
  note: string | null;
  created_at: number;
}

function mapLink(row: LinkRow): Link {
  return {
    id: row.id,
    fromItemId: row.from_item_id,
    toItemId: row.to_item_id,
    relation: row.relation,
    note: row.note,
    createdAt: row.created_at,
  };
}

/**
 * 建立条目间的关系。
 * relation 由 AI 现场决定（「来源于」「催办」「属于」…），不预设枚举。
 * 同一对条目同一关系重复写入会被唯一约束挡掉，此时返回已存在的那条。
 */
export function createLink(
  db: Db,
  input: { fromItemId: string; toItemId: string; relation: string; note?: string | null },
): Link {
  const id = randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO links (id, from_item_id, to_item_id, relation, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.fromItemId, input.toItemId, input.relation, input.note ?? null, Date.now());

  const row = db
    .prepare(
      'SELECT * FROM links WHERE from_item_id = ? AND to_item_id = ? AND relation = ?',
    )
    .get(input.fromItemId, input.toItemId, input.relation) as LinkRow;
  return mapLink(row);
}

/** 取某个条目的全部关联（双向） */
export function listLinksFor(db: Db, itemId: string): Link[] {
  const rows = db
    .prepare('SELECT * FROM links WHERE from_item_id = ? OR to_item_id = ? ORDER BY created_at DESC')
    .all(itemId, itemId) as LinkRow[];
  return rows.map(mapLink);
}

export function deleteLink(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM links WHERE id = ?').run(id).changes > 0;
}