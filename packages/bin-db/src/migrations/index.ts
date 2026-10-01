import type { Migration } from './types.js';
import { migration001Init } from './001_init.js';
import { migration002ItemSoftDelete } from './002_item_soft_delete.js';

// 迁移必须按数组顺序追加，已发布的迁移不要修改，只往后加新的
export const migrations: Migration[] = [migration001Init, migration002ItemSoftDelete];

export type { Migration } from './types.js';