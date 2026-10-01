import type { Migration } from './types.js';

/**
 * 001 初始化 schema。
 *
 * 设计要点（详见方案说明）：
 * - 没有任何一张表绑定"采购""账号"这类业务概念，全部是通用结构，
 *   类型由 AI 在写入时创建与演化。
 * - items.data 用 JSON 承载随类型变化的字段，同时把高频筛选字段
 *   （type_id / status / occurred_at）提成真列以保证查询效率。
 * - entries 保存录入原话且只增不改，用于溯源与"重新归类"。
 * - 保险箱独立成一表并加密，永不进入索引层。
 * - search_index 用 trigram 分词器：SQLite 默认的 unicode61 会把整句中文
 *   当成一个词，中文子串检索基本失效，trigram 才能按三字滑窗匹配。
 */
export const migration001Init: Migration = {
  name: '001_init',
  sql: `
-- ---------------------------------------------------------------------------
-- 类型定义：由 AI 创建与演化，不是人预先设定的
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS type_defs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  fields      TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'merged')),
  merged_into TEXT REFERENCES type_defs(id),
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL DEFAULT 'ai' CHECK (created_by IN ('ai', 'user')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 同名类型只允许存在一个（已被合并的除外），保证复用时的唯一性
CREATE UNIQUE INDEX IF NOT EXISTS idx_type_defs_name ON type_defs(name) WHERE status <> 'merged';
CREATE INDEX IF NOT EXISTS idx_type_defs_status ON type_defs(status, usage_count DESC);

-- ---------------------------------------------------------------------------
-- 录入原话：不可变，保留"用户当时到底说了什么"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  raw_text    TEXT NOT NULL,
  session_id  TEXT,
  ai_decision TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);

-- ---------------------------------------------------------------------------
-- 条目：任何信息最终都落在这里，字段随类型变化
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,
  type_id         TEXT NOT NULL REFERENCES type_defs(id) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  summary         TEXT,
  data            TEXT NOT NULL DEFAULT '{}',
  status          TEXT,
  occurred_at     INTEGER,
  confidence      REAL,
  source_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_occurred ON items(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at DESC);

-- ---------------------------------------------------------------------------
-- 关系：条目之间的图谱
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS links (
  id           TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  to_item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (from_item_id, to_item_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_item_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_item_id);

-- ---------------------------------------------------------------------------
-- 文件引用：只存路径与摘要，原始文件留在原地不迁移
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  item_id        TEXT REFERENCES items(id) ON DELETE SET NULL,
  path           TEXT NOT NULL,
  filename       TEXT NOT NULL,
  ext            TEXT,
  mime           TEXT,
  size           INTEGER,
  sha256         TEXT,
  extracted_text TEXT,
  extract_status TEXT NOT NULL DEFAULT 'pending',
  created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);
CREATE INDEX IF NOT EXISTS idx_assets_item ON assets(item_id);

-- ---------------------------------------------------------------------------
-- 保险箱：独立加密存储，不进入任何索引，也不写入对话日志
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  kind         TEXT,
  item_id      TEXT REFERENCES items(id) ON DELETE SET NULL,
  username_enc BLOB,
  cipher       BLOB NOT NULL,
  iv           BLOB NOT NULL,
  auth_tag     BLOB,
  hint         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_label ON vault(label);

-- ---------------------------------------------------------------------------
-- 应用级键值配置（如保险箱 KDF 盐值、嵌入模型记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 全文索引：独立表，由仓储层在写入时显式同步（不用触发器，便于同时索引条目/文件/原话）
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  obj_id    UNINDEXED,
  obj_kind  UNINDEXED,
  text,
  tokenize = 'trigram'
);

-- ---------------------------------------------------------------------------
-- 向量索引：以 BLOB 存原始 float32，检索时在 Node 侧算余弦相似度
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vec_index (
  obj_id     TEXT NOT NULL,
  obj_kind   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (obj_id, obj_kind, model)
);
`,
};