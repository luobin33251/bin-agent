import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

// 字段类型：AI 建类型时给每个字段声明一个，决定前端如何渲染与校验
export type TypeFieldType = 'text' | 'number' | 'date' | 'boolean' | 'enum' | 'json';

export interface TypeFieldDef {
  key: string; // 字段标识，如 amount
  label: string; // 中文名，如 金额
  type: TypeFieldType;
  required?: boolean;
  options?: string[]; // type 为 enum 时的可选值
  description?: string; // 给 AI 看的说明，帮助后续复用时正确填值
}

export type TypeStatus = 'draft' | 'active' | 'merged';
export type TypeCreatedBy = 'ai' | 'user';

export interface ItemType {
  id: string;
  name: string;
  description: string | null;
  fields: TypeFieldDef[];
  status: TypeStatus;
  mergedInto: string | null;
  usageCount: number;
  createdBy: TypeCreatedBy;
  createdAt: number;
  updatedAt: number;
}

interface TypeRow {
  id: string;
  name: string;
  description: string | null;
  fields: string;
  status: string;
  merged_into: string | null;
  usage_count: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function mapType(row: TypeRow): ItemType {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fields: safeParseFields(row.fields),
    status: row.status as TypeStatus,
    mergedInto: row.merged_into,
    usageCount: row.usage_count,
    createdBy: row.created_by as TypeCreatedBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseFields(raw: string): TypeFieldDef[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TypeFieldDef[]) : [];
  } catch {
    return [];
  }
}

export interface CreateTypeInput {
  name: string;
  description?: string | null;
  fields?: TypeFieldDef[];
  createdBy?: TypeCreatedBy;
  status?: TypeStatus;
}

/**
 * 新建类型。同名类型已存在时返回 null（调用方应先 findTypeByName 做复用判断，
 * 这里返回 null 是为了把"复用优先"的决定权留在 Agent 侧而不是悄悄吞掉）。
 */
export function createType(db: Db, input: CreateTypeInput): ItemType | null {
  const now = Date.now();
  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO type_defs
         (id, name, description, fields, status, usage_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.fields ?? []),
      input.status ?? 'draft',
      input.createdBy ?? 'ai',
      now,
      now,
    );

  if (result.changes === 0) return null;
  return getTypeById(db, id);
}

export function getTypeById(db: Db, id: string): ItemType | null {
  const row = db.prepare('SELECT * FROM type_defs WHERE id = ?').get(id) as TypeRow | undefined;
  return row ? mapType(row) : null;
}

/** 按名称精确查找未合并的类型 */
export function findTypeByName(db: Db, name: string): ItemType | null {
  const row = db
    .prepare("SELECT * FROM type_defs WHERE name = ? AND status <> 'merged'")
    .get(name) as TypeRow | undefined;
  return row ? mapType(row) : null;
}

/**
 * 按关键词模糊匹配已有类别（名称或说明命中）。
 * 写入前用它判断「能不能归到已有类别里」——这是抑制类型碎片化的第一道闸。
 * 空查询返回全部类别，供「先看看都有哪些类别」的场景使用。
 */
export function searchTypes(db: Db, query: string): ItemType[] {
  const trimmed = query.trim();
  if (!trimmed) return listTypes(db);

  const pattern = `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM type_defs
        WHERE status <> 'merged'
          AND (name LIKE ? ESCAPE '\\' OR COALESCE(description, '') LIKE ? ESCAPE '\\')
        ORDER BY usage_count DESC, updated_at DESC
        LIMIT 50`,
    )
    .all(pattern, pattern) as TypeRow[];

  return rows.map(mapType);
}

/** 未合并的类型总数。用于告诉调用方「库里到底有多少东西」，与某次查询命中了多少无关 */
export function countTypes(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM type_defs WHERE status <> 'merged'")
    .get() as { c: number };
  return row.c;
}

export interface ListTypesOptions {
  status?: TypeStatus;
  includeMerged?: boolean;
  limit?: number;
}

export function listTypes(db: Db, options: ListTypesOptions = {}): ItemType[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  } else if (!options.includeMerged) {
    conditions.push("status <> 'merged'");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 200;
  params.push(limit);

  const rows = db
    .prepare(`SELECT * FROM type_defs ${where} ORDER BY usage_count DESC, updated_at DESC LIMIT ?`)
    .all(...params) as TypeRow[];

  return rows.map(mapType);
}

/** 更新类型定义（AI 复用时补充字段，或用户手动修正） */
export function updateType(
  db: Db,
  id: string,
  patch: { name?: string; description?: string | null; fields?: TypeFieldDef[]; status?: TypeStatus },
): ItemType | null {
  const current = getTypeById(db, id);
  if (!current) return null;

  db.prepare(
    `UPDATE type_defs
        SET name = ?, description = ?, fields = ?, status = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.description !== undefined ? patch.description : current.description,
    JSON.stringify(patch.fields ?? current.fields),
    patch.status ?? current.status,
    Date.now(),
    id,
  );

  return getTypeById(db, id);
}

/** 类型被复用一次，使用计数 +1；计数用于识别"只用过一次"的碎片类型 */
export function incrementTypeUsage(db: Db, id: string): void {
  db.prepare('UPDATE type_defs SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?').run(
    Date.now(),
    id,
  );
}

/**
 * 合并两个类型：把 from 标记为 merged、指向 to，并把 from 名下的条目改挂到 to。
 * 历史条目一条不丢，只是换了归属。
 */
export function mergeType(db: Db, fromId: string, toId: string): void {
  if (fromId === toId) return;

  const apply = db.transaction(() => {
    const now = Date.now();
    db.prepare(
      "UPDATE type_defs SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?",
    ).run(toId, now, fromId);
    db.prepare('UPDATE items SET type_id = ?, updated_at = ? WHERE type_id = ?').run(toId, now, fromId);
  });

  apply();
}