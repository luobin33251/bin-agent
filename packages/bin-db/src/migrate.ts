import type { Db } from './client.js';
import { migrations } from './migrations/index.js';

/**
 * 版本化迁移：按顺序执行 migrations 数组里尚未应用过的项。
 * 每条迁移在独立事务里执行，失败会整体回滚，不会留下半截 schema。
 */
export function runMigrations(db: Db): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const appliedRows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((row) => row.name));

  const insert = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  const executed: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.name, Date.now());
    });

    apply();
    executed.push(migration.name);
  }

  return executed;
}

/** 已应用的迁移名列表，用于启动自检 */
export function listAppliedMigrations(db: Db): string[] {
  const rows = db
    .prepare('SELECT name FROM _migrations ORDER BY name')
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}