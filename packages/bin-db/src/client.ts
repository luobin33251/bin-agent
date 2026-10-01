import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';

export type Db = Database.Database;

let instance: Db | null = null;

/**
 * 打开（或创建）SQLite 连接。
 * WAL 模式让读写可以并发，foreign_keys 打开以保证 links/assets 的级联删除生效。
 */
export function openDatabase(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  return db;
}

/** 初始化全局单例，同时跑一遍迁移。重复调用是安全的 */
export function initDatabase(file: string, options?: { migrate?: boolean }): Db {
  if (instance) return instance;

  const db = openDatabase(file);
  if (options?.migrate !== false) {
    const executed = runMigrations(db);
    if (executed.length > 0) {
      console.log(`[DB] 已应用迁移: ${executed.join(', ')}`);
    }
  }

  instance = db;
  return db;
}

export function getDatabase(): Db {
  if (!instance) {
    throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}