import type { Db } from '../client.js';

/**
 * 应用级键值配置。
 *
 * 目前存的是保险箱的 KDF 盐值与校验块——这些都不能写进代码或 .env：
 * 盐必须是随机的、且跟着数据库走，否则换台机器就解不开自己的保险箱。
 */
export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function deleteMeta(db: Db, key: string): void {
  db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
}