import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../client.js';
import { listAppliedMigrations, runMigrations } from '../migrate.js';

// 独立迁移脚本：不启动服务也能建库、查看 schema，便于开发期自检
// 用法：pnpm --filter @bin/db migrate
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../../..');
const dbFile = path.resolve(projectRoot, process.env.DB_FILE ?? './data/bin.db');

const db = openDatabase(dbFile);
const executed = runMigrations(db);

console.log(`数据库文件: ${dbFile}`);
console.log(executed.length > 0 ? `本次应用迁移: ${executed.join(', ')}` : '本次无新迁移');
console.log(`已应用迁移: ${listAppliedMigrations(db).join(', ') || '(无)'}`);

const tables = db
  .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as Array<{ name: string; type: string }>;

console.log(`\nschema 对象（${tables.length}）:`);
for (const table of tables) {
  console.log(`  ${table.type.padEnd(7)} ${table.name}`);
}

db.close();