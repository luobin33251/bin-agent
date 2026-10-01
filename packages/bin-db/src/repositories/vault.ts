import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

/**
 * 保险箱条目。
 *
 * 注意这里全是**密文**：`cipher` / `iv` / `authTag` 都是加密产物，
 * 解密发生在 bin-server 的 vault/crypto 模块里。数据层不认识明文，
 * 这样「明文不落盘」就不是靠调用方自觉，而是这一层压根没有明文可写。
 *
 * `cipher` 里装的是一个 JSON（账号 + 密码一起加密），不只用它存密码——
 * GCM 的 iv 绝不能复用，两个字段要是各加密一次就得各配一套 iv，
 * 而表里只有一套 iv/auth_tag 列。所以一次加密两个字段。
 * `username_enc` 因此没有用上（001_init 建表时预留的），保留列不动，别拿它写半套密文。
 */
export interface VaultEntry {
  id: string;
  label: string;
  kind: string | null;
  itemId: string | null;
  usernameEnc: Buffer | null;
  cipher: Buffer;
  iv: Buffer;
  authTag: Buffer | null;
  hint: string | null;
  createdAt: number;
  updatedAt: number;
}

interface VaultRow {
  id: string;
  label: string;
  kind: string | null;
  item_id: string | null;
  username_enc: Buffer | null;
  cipher: Buffer;
  iv: Buffer;
  auth_tag: Buffer | null;
  hint: string | null;
  created_at: number;
  updated_at: number;
}

function mapVault(row: VaultRow): VaultEntry {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    itemId: row.item_id,
    usernameEnc: row.username_enc,
    cipher: row.cipher,
    iv: row.iv,
    authTag: row.auth_tag,
    hint: row.hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVaultEntryInput {
  label: string;
  kind?: string | null;
  itemId?: string | null;
  usernameEnc?: Buffer | null;
  cipher: Buffer;
  iv: Buffer;
  authTag?: Buffer | null;
  hint?: string | null;
}

export function createVaultEntry(db: Db, input: CreateVaultEntryInput): VaultEntry {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO vault
       (id, label, kind, item_id, username_enc, cipher, iv, auth_tag, hint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.label,
    input.kind ?? null,
    input.itemId ?? null,
    input.usernameEnc ?? null,
    input.cipher,
    input.iv,
    input.authTag ?? null,
    input.hint ?? null,
    now,
    now,
  );

  return getVaultEntry(db, id)!;
}

/**
 * 只返回 id/label/kind/hint 这类元信息，**不含任何密文字段**。
 *
 * 列表页不需要密文，少传一次就少一个泄漏面；
 * 要解密哪一条，用 getVaultEntry 单独取。
 */
export interface VaultEntryMeta {
  id: string;
  label: string;
  kind: string | null;
  itemId: string | null;
  hint: string | null;
  createdAt: number;
  updatedAt: number;
}

export function listVaultEntries(db: Db): VaultEntryMeta[] {
  const rows = db
    .prepare(
      `SELECT id, label, kind, item_id, hint, created_at, updated_at
         FROM vault ORDER BY label COLLATE NOCASE ASC, created_at ASC`,
    )
    .all() as Array<{
    id: string;
    label: string;
    kind: string | null;
    item_id: string | null;
    hint: string | null;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    itemId: row.item_id,
    hint: row.hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getVaultEntry(db: Db, id: string): VaultEntry | null {
  const row = db.prepare('SELECT * FROM vault WHERE id = ?').get(id) as VaultRow | undefined;
  return row ? mapVault(row) : null;
}

export function countVaultEntries(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM vault').get() as { c: number };
  return row.c;
}

export interface UpdateVaultEntryInput {
  label?: string;
  kind?: string | null;
  hint?: string | null;
  /** 重新加密后的三件套，一起传或一起不传 */
  usernameEnc?: Buffer | null;
  cipher?: Buffer;
  iv?: Buffer;
  authTag?: Buffer | null;
}

export function updateVaultEntry(db: Db, id: string, patch: UpdateVaultEntryInput): VaultEntry | null {
  const current = getVaultEntry(db, id);
  if (!current) return null;

  db.prepare(
    `UPDATE vault
        SET label = ?, kind = ?, hint = ?, username_enc = ?, cipher = ?, iv = ?, auth_tag = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.label ?? current.label,
    patch.kind !== undefined ? patch.kind : current.kind,
    patch.hint !== undefined ? patch.hint : current.hint,
    patch.usernameEnc !== undefined ? patch.usernameEnc : current.usernameEnc,
    patch.cipher ?? current.cipher,
    patch.iv ?? current.iv,
    patch.authTag !== undefined ? patch.authTag : current.authTag,
    Date.now(),
    id,
  );

  return getVaultEntry(db, id);
}

/** 硬删除。保险箱里放的是凭证，留着"已删除"的密文没有意义，反而多一处风险 */
export function deleteVaultEntry(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM vault WHERE id = ?').run(id).changes > 0;
}