// 数据层对外出口
export type { Db } from './client.js';
export { closeDatabase, getDatabase, initDatabase, openDatabase } from './client.js';
export { listAppliedMigrations, runMigrations } from './migrate.js';
export type { Migration } from './migrations/index.js';
export { migrations } from './migrations/index.js';

export type {
  CreateItemInput,
  CreateTypeInput,
  Entry,
  Item,
  ItemSearchHit,
  ItemType,
  Link,
  ListItemsOptions,
  ListTypesOptions,
  SearchItemsOptions,
  TypeCreatedBy,
  TypeFieldDef,
  TypeFieldType,
  TypeStatus,
  UpdateItemInput,
  CreateVaultEntryInput,
  UpdateVaultEntryInput,
  VaultEntry,
  VaultEntryMeta,
} from './repositories/index.js';
export {
  appendEntry,
  countItems,
  countTypes,
  countVaultEntries,
  createItem,
  createLink,
  createType,
  createVaultEntry,
  deleteItem,
  deleteLink,
  deleteMeta,
  deleteVaultEntry,
  findSimilarItems,
  findTypeByName,
  getEntryById,
  getItemById,
  getItemIndexText,
  getMeta,
  getTypeById,
  getVaultEntry,
  incrementTypeUsage,
  listItems,
  listLinksFor,
  listRecentEntries,
  listTypes,
  listVaultEntries,
  mergeItems,
  mergeType,
  restoreItem,
  searchItems,
  searchTypes,
  setMeta,
  updateItem,
  updateType,
  updateVaultEntry,
} from './repositories/index.js';

// 索引层：全文（FTS5）、向量（暴力余弦）、融合（RRF）
export type { IndexKind, SearchHit } from './search/index.js';
export { countIndexed, indexObject, removeFromIndex, searchIndex } from './search/index.js';
export type { FusedHit, MatchSource, RankedList } from './search/hybrid.js';
export { fuseRanked } from './search/hybrid.js';
export type { SearchVectorsOptions, UpsertVectorInput, VectorHit } from './search/vector.js';
export {
  countVectors,
  decodeVector,
  encodeVector,
  listUnindexedItemIds,
  removeVector,
  searchVectors,
  upsertVector,
} from './search/vector.js';