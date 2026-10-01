export type { ItemType, TypeFieldDef, TypeFieldType, TypeStatus, TypeCreatedBy } from './types.js';
export type { CreateTypeInput, ListTypesOptions } from './types.js';
export {
  countTypes,
  createType,
  findTypeByName,
  getTypeById,
  incrementTypeUsage,
  listTypes,
  mergeType,
  searchTypes,
  updateType,
} from './types.js';

export type { Entry } from './entries.js';
export { appendEntry, getEntryById, listRecentEntries } from './entries.js';

export type { Link } from './links.js';
export { createLink, deleteLink, listLinksFor } from './links.js';

export type { CreateVaultEntryInput, UpdateVaultEntryInput, VaultEntry, VaultEntryMeta } from './vault.js';
export {
  countVaultEntries,
  createVaultEntry,
  deleteVaultEntry,
  getVaultEntry,
  listVaultEntries,
  updateVaultEntry,
} from './vault.js';

export { deleteMeta, getMeta, setMeta } from './meta.js';

export type { Item } from './items.js';
export type {
  CreateItemInput,
  ItemSearchHit,
  ListItemsOptions,
  SearchItemsOptions,
  UpdateItemInput,
} from './items.js';
export {
  countItems,
  createItem,
  deleteItem,
  findSimilarItems,
  getItemById,
  getItemIndexText,
  listItems,
  mergeItems,
  restoreItem,
  searchItems,
  updateItem,
} from './items.js';