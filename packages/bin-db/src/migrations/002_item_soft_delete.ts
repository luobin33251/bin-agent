import type { Migration } from './types.js';

/**
 * 002 条目软删除。
 *
 * 为什么不直接 DELETE：删除是不可逆操作，而这是一个"记忆"系统——
 * 用户误删的代价远高于留着一行带标记的数据。
 * 软删除让删除动作可以随时反悔，也和 entries「只增不改」的原则一致。
 *
 * 代价是所有查询都要带 deleted_at IS NULL 过滤，这个过滤集中在仓储层，
 * 不允许调用方自己拼 SQL 绕过。
 */
export const migration002ItemSoftDelete: Migration = {
  name: '002_item_soft_delete',
  sql: `
ALTER TABLE items ADD COLUMN deleted_at INTEGER;

-- 部分索引：只索引未删除的条目，让「查未删除」这条最常用的路径走索引
CREATE INDEX IF NOT EXISTS idx_items_alive ON items(deleted_at) WHERE deleted_at IS NULL;
`,
};