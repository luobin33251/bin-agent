# 数据模型

数据库文件位于 `data/bin.db`（SQLite，WAL 模式，`foreign_keys = ON`）。

schema 定义在 [packages/bin-db/src/migrations/001_init.ts](../packages/bin-db/src/migrations/001_init.ts)，
全部内容只有 **6 张业务表 + 1 张配置表 + 2 张索引虚表**，没有任何一张绑定具体业务概念。

## 1. 设计原则

### 原则一：结构后置，而不是前置

用户录入的信息类型不可预知，所以**不能**给每类信息建独立表。
所有信息统一落在 `items` 表，字段放在 `data` 这个 JSON 列里：

```jsonc
// 「读书心得」类型的条目
{ "书": "原则", "核心收获": "把决策当成可复盘的流程" }

// 「采购跟进」类型的条目
{ "主体": "某供应商", "金额": 62995, "付款日期": "2026-07-10" }
```

两者共用同一行表结构，互不干扰。新增任何信息类型都不需要改表。

### 原则二：高频字段提成真列

纯 JSON 的问题是查不快。所以把**一定会用来筛选**的字段提升为真列：

- `type_id` —— 按类别查
- `status` —— 按状态查（「哪些还没完成」）
- `occurred_at` —— 按时间查
- `updated_at` —— 按最近修改查

这些走 B-tree 索引，不扫 JSON。

### 原则三：索引可以后长

SQLite 支持在 JSON 上建**生成列**。等某个类型用多了、确实需要按某字段聚合时，
再动态加索引，不需要迁移数据：

```sql
ALTER TABLE items ADD COLUMN amount REAL
  GENERATED ALWAYS AS (json_extract(data, '$.金额')) VIRTUAL;
CREATE INDEX idx_items_amount ON items(amount);
```

这就是「通用性」和「可统计」能同时成立的原因。

### 原则四：原话不可变

`entries` 表只增不改。AI 归类一定会有错的时候，原话留着才能重新归类、追溯、审计。

## 2. 表结构

### type_defs —— 类型定义（由 AI 创建与演化）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `name` | TEXT NOT NULL | 类别名，如「读书心得」 |
| `description` | TEXT | 给 AI 看的语义说明，帮助复用时正确判断 |
| `fields` | TEXT NOT NULL DEFAULT `'[]'` | JSON 数组，字段定义 |
| `status` | TEXT NOT NULL DEFAULT `'draft'` | `draft` / `active` / `merged` |
| `merged_into` | TEXT → type_defs(id) | 被合并到哪个类型 |
| `usage_count` | INTEGER NOT NULL DEFAULT 0 | 使用次数，用于识别碎片类型 |
| `created_by` | TEXT NOT NULL DEFAULT `'ai'` | `ai` / `user` |
| `created_at` / `updated_at` | INTEGER | 毫秒时间戳 |

`fields` 的元素结构：

```jsonc
{
  "key": "amount",            // 字段标识
  "label": "金额",             // 中文名
  "type": "number",           // text | number | date | boolean | enum | json
  "required": true,
  "options": ["待办", "进行中", "已完成"],  // type 为 enum 时
  "description": "采购总金额，含税"          // 给 AI 的填值说明
}
```

索引：

```sql
CREATE UNIQUE INDEX idx_type_defs_name ON type_defs(name) WHERE status <> 'merged';
CREATE INDEX idx_type_defs_status ON type_defs(status, usage_count DESC);
```

第一条是**部分唯一索引**：同名类型只允许存在一个，但已被合并的除外
（合并后源类型保留原名，不能再被占用）。

### entries —— 录入原话（不可变）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `raw_text` | TEXT NOT NULL | 用户当时说的原话 |
| `session_id` | TEXT | 来自哪次会话 |
| `ai_decision` | TEXT | JSON，AI 当时怎么归类的（类型、字段、理由），便于回放 |
| `created_at` | INTEGER NOT NULL | |

> 没有 `updated_at`——这张表不做更新。

### items —— 条目（所有信息最终都落这里）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `type_id` | TEXT NOT NULL → type_defs(id) | `ON DELETE RESTRICT` |
| `title` | TEXT NOT NULL | 条目标题 |
| `summary` | TEXT | 一句话摘要，用于列表展示与嵌入 |
| `data` | TEXT NOT NULL DEFAULT `'{}'` | JSON，字段随类型变化 |
| `status` | TEXT | 类型自定义的状态值，如「待办」「已完结」 |
| `occurred_at` | INTEGER | **事情发生**的时间，可能早于录入时间 |
| `confidence` | REAL | AI 归类置信度，低于阈值的可提示用户确认 |
| `source_entry_id` | TEXT → entries(id) | `ON DELETE SET NULL`，溯源 |
| `deleted_at` | INTEGER | 非空表示已软删除（迁移 002 加入） |
| `created_at` / `updated_at` | INTEGER NOT NULL | |

`type_id` 用 `RESTRICT` 而不是 `CASCADE`：删除类型时若名下还有条目应该直接失败，
正确做法是走 `mergeType()` 合并，而不是删掉导致数据丢失。

**软删除**：`delete_memory` 只打 `deleted_at` 标记，数据行保留，这样删除可以反悔。
过滤条件写在仓储函数内部（`listItems` / `getItemById` / `searchItems` / `countItems`），
调用方拿不到"未过滤"的版本，也就不可能忘记加条件。

索引：`type_id`、`status`、`occurred_at DESC`、`updated_at DESC`，
外加一个只覆盖未删除行的部分索引 `idx_items_alive`。

### links —— 条目间的关系图谱

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | |
| `from_item_id` | TEXT NOT NULL → items(id) | `ON DELETE CASCADE` |
| `to_item_id` | TEXT NOT NULL → items(id) | `ON DELETE CASCADE` |
| `relation` | TEXT NOT NULL | 关系名，如「来源于」「催办」「属于」 |
| `note` | TEXT | 补充说明 |
| `created_at` | INTEGER NOT NULL | |

约束 `UNIQUE (from_item_id, to_item_id, relation)`——同一对条目同一关系不允许重复。
索引正反向各一个，便于双向遍历。

关系名由 AI 现场决定，不预设枚举。

### assets —— 文件引用（原始文件不迁移）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | |
| `item_id` | TEXT → items(id) | `ON DELETE SET NULL` |
| `path` | TEXT NOT NULL | **绝对路径**，指向原始文件 |
| `filename` | TEXT NOT NULL | |
| `ext` / `mime` / `size` | | 文件元信息 |
| `sha256` | TEXT | 内容哈希，用于去重与变化检测 |
| `extracted_text` | TEXT | PDF/Excel/OCR 抽取出的文本，供全文检索 |
| `extract_status` | TEXT NOT NULL DEFAULT `'pending'` | |
| `created_at` | INTEGER NOT NULL | |

`path` 上有唯一索引。**这张表不存文件内容**——本地资料目录里的文件留在原地，
系统只记录「它在哪、是什么、跟哪条记录有关」。

### vault —— 保险箱（独立加密）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | |
| `label` | TEXT NOT NULL | 如「内部管理系统」「ERP-1 服务器」 |
| `kind` | TEXT | `account` / `server` / `api_key` / … |
| `item_id` | TEXT → items(id) | 可选关联到某个条目 |
| `username_enc` | BLOB | **M4 实现后未使用**，见下方说明 |
| `cipher` | BLOB NOT NULL | AES-256-GCM 密文，里面是 `{"username":"…","password":"…"}` |
| `iv` | BLOB NOT NULL | |
| `auth_tag` | BLOB | GCM 认证标签，用于校验完整性 |
| `hint` | TEXT | 明文提示，如「上个月改过」 |
| `created_at` / `updated_at` | INTEGER NOT NULL | |

**这张表永不写入 `search_index` / `vec_index`，也永不进对话日志。**

`label` / `kind` / `hint` 保持明文——列表要展示它们，加密了就没法按名字排序和检索提示。
真正敏感的账号与密码进 `cipher`。

**为什么账号和密码合在一条密文里，而不是各占 `username_enc` / `cipher`：**
GCM 的 iv 绝不能复用（同一个 key 下重复 iv 会泄露明文异或关系），
两个字段各加密一次就得各配一套 iv，而这张表只有一套 `iv` / `auth_tag` 列。
所以一次加密两个字段，`username_enc` 因此没有用上——列保留不动，
但**不要拿它去写半套密文**。

### app_meta —— 应用级配置

`key` / `value` / `updated_at` 的简单键值表。M4 实际写入两个键：

| key | 内容 |
|---|---|
| `vault.kdf.salt` | scrypt 的盐（base64）。必须跟着数据库走，否则换台机器就解不开自己的保险箱 |
| `vault.check` | 校验块：用派生密钥加密的一段固定明文（`iv‖tag‖cipher` 的 base64）。能解开它就说明主密码对——所以不需要单独存密码哈希 |

密钥本身不落库，只在服务端进程内存里，30 分钟无操作清空。

## 3. 索引层

### search_index —— FTS5 全文索引

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  obj_id    UNINDEXED,
  obj_kind  UNINDEXED,   -- item | asset | entry
  text,
  tokenize = 'trigram'
);
```

- 是**独立表**，不是 external content 表——因为要同时索引条目、文件抽取文本、原话三种来源
- 用 `trigram` 分词器，原因见 [architecture.md](architecture.md#7-检索层设计)
- **不用触发器同步**，由仓储层在写入时显式调用，控制更细、更容易调试。
  M1 已在 [items.ts](../packages/bin-db/src/repositories/items.ts) 的
  `createItem` / `updateItem` / `deleteItem` 里接通，忘同步这件事不可能发生
- 查询走 **FTS + LIKE 双路**：`trigram` 按三字滑窗建索引，
  少于 3 个字符的查询（「空调」「合同」）切不出 token，必须用 LIKE 兜底

创建 FTS5 虚拟表时会自动生成 `search_index_data` / `_idx` / `_content` /
`_docsize` / `_config` 五张影子表，属正常现象。

### vec_index —— 向量索引

| 字段 | 说明 |
|------|------|
| `obj_id` + `obj_kind` + `model` | 联合主键 |
| `dim` | 向量维度 |
| `embedding` | BLOB，float32 原始字节 |
| `updated_at` | |

按 `model` 分行存储，将来换嵌入模型时可以新旧并存、逐步回填。
检索时在 Node 里反序列化后算余弦相似度。

> ⚠️ M1 结束时这张表仍是空的，向量检索在 M2 接入。

## 3.1 类型的创建与合并约定

`status` 的取值语义在 M1 落地时明确为：

| 值 | 含义 |
|---|---|
| `active` | 已被真实条目使用（`save_memory` 创建时即为 active），`usage_count` 从 1 开始 |
| `draft` | 预留：AI 建议但尚无用例的类别 |
| `merged` | 已被合并到别的类别，`merged_into` 指向目标 |

`usage_count = 1` 是识别「碎片类型」的信号——只出现过一次的类别，
多半是可以并进其他类别的。

## 4. 常用查询

```sql
-- 某类别下最近的条目
SELECT * FROM items WHERE type_id = ? ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 50;

-- 还没完成的事项
SELECT * FROM items WHERE status IN ('待办', '进行中');

-- 中文全文检索（trigram）
SELECT obj_id, obj_kind FROM search_index WHERE search_index MATCH '空压机';

-- 从 JSON 里取字段
SELECT json_extract(data, '$.金额') AS amount FROM items WHERE type_id = ?;

-- 找出只用过一次的类型（碎片候选）
SELECT id, name FROM type_defs WHERE status <> 'merged' AND usage_count = 1;

-- 某条目的全部关联
SELECT * FROM links WHERE from_item_id = ? OR to_item_id = ?;
```

## 5. 迁移约定

- 迁移定义在 `packages/bin-db/src/migrations/NNN_name.ts`，导出 `{ name, sql }`
- 在 `migrations/index.ts` 的数组里**按顺序追加**
- **已发布的迁移不要修改**，只往后加新的
- 每条迁移在独立事务里执行，失败整体回滚，不会留下半截 schema
- 应用记录写在 `_migrations` 表

```bash
pnpm --filter @bin/db migrate   # 执行迁移并打印 schema 对象清单
```

服务启动时（`initDatabase()`）会自动跑一遍，重复执行是安全的。