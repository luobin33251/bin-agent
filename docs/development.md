# 开发指南

## 1. 环境与首次配置

```bash
# 环境要求：Node.js >= 20、pnpm
pnpm install
cp .env.example .env        # 至少填写 LLM_API_KEY
pnpm --filter @bin/db migrate
pnpm dev                    # 后端 3100 + 前端 5173
```

`.env` 关键项：

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | OpenAI 兼容接口地址，默认指向阿里云百炼 MaaS |
| `LLM_API_KEY` | 对话模型密钥 |
| `LLM_MODEL` | 模型名，默认 `deepseek-v4-flash` |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` / `EMBED_DIM` | 向量模型配置，**与对话模型分开、不回落**。`EMBED_API_KEY` 留空 = 语义检索关闭，检索退化为纯关键词 |
| `DB_FILE` | SQLite 文件路径，相对仓库根目录 |

### 语义检索与向量索引

向量不是一次算完就完事的，改动代码时要知道这条链路：

| 环节 | 在哪 | 说明 |
|------|------|------|
| 拼检索文本 | `bin-db/src/repositories/items.ts` 的 `composeIndexText` | **FTS 与向量共用同一份文本**，改这里等于同时改两路检索 |
| 算向量 | `bin-server/src/memory/vectors.ts` | 写入后算，失败只 warning，不影响落库 |
| 补齐漏算 | 启动自检（后台）+ `pnpm reindex`（手动） | 靠 `listUnindexedItemIds` 比对差集 |
| 融合 | `bin-db/src/search/hybrid.ts` | RRF，`k=60` |
| 下限 | `searchVectors` 的 `minScore`（0.4，实测定的） | 防止无关查询也挤进结果头部；**改它之前先在真实数据上看分布** |

加新工具时若它会改条目内容（比如批量改字段），**记得在落库后调一次
`vectors.indexItem(itemId)`**——漏了不会报错，只会让那条语义搜不到，
得等下次启动自检才补上。

## 2. 各包职责速查

| 包 | 职责 | 不该做的事 |
|----|------|-----------|
| `bin-ai` | 与模型通信：消息格式、流式解析、工具定义转换 | 不含业务逻辑 |
| `bin-core` | Agent 循环、工具注册表、会话管理 | 不认识任何具体工具，也不碰数据库 |
| `bin-db` | 连接、迁移、仓储、索引 | 不依赖 `bin-core`，可脱离 Agent 单独测试 |
| `bin-server` | HTTP 接口、具体工具实现、系统提示词 | 不直接写 SQL，一律走 `bin-db` 的仓储函数 |
| `apps/web` | 界面 | 不含业务规则 |

**依赖方向严格单向**：`web → server → core → ai`，`server → db`。反向依赖一律禁止。

## 3. 加一个数据库迁移

1. 新建 `packages/bin-db/src/migrations/002_xxx.ts`：

```typescript
import type { Migration } from './types.js';

export const migration002Xxx: Migration = {
  name: '002_xxx',
  sql: `
CREATE TABLE IF NOT EXISTS example (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_example_created ON example(created_at DESC);
`,
};
```

2. 在 `migrations/index.ts` 的数组**末尾追加**：

```typescript
export const migrations: Migration[] = [migration001Init, migration002Xxx];
```

3. 执行并确认：

```bash
pnpm --filter @bin/db migrate
```

**约定**

- 迁移名必须唯一且有序，`NNN_描述`
- **已发布的迁移不要修改**，只往后加新的
- 每条迁移在独立事务中执行，失败会整体回滚
- 建表语句统一用 `IF NOT EXISTS`，便于在已有库上重跑

## 4. 加一个仓储

在 `packages/bin-db/src/repositories/` 下新建文件，模式参考
[repositories/types.ts](../packages/bin-db/src/repositories/types.ts)：

```typescript
import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

// 1) 定义对外暴露的领域类型（驼峰），不要把数据库行类型透出去
export interface Example {
  id: string;
  createdAt: number;
}

// 2) 定义数据库行类型（下划线），与表结构一一对应
interface ExampleRow {
  id: string;
  created_at: number;
}

// 3) 映射函数：集中处理 JSON 解析与字段名转换
function mapExample(row: ExampleRow): Example {
  return { id: row.id, createdAt: row.created_at };
}

// 4) 导出面向业务的函数，参数里第一位永远是 db
export function createExample(db: Db, input: { id?: string }): Example {
  const id = input.id ?? randomUUID();
  db.prepare('INSERT INTO example (id, created_at) VALUES (?, ?)').run(id, Date.now());
  return getExampleById(db, id)!;
}

export function getExampleById(db: Db, id: string): Example | null {
  const row = db.prepare('SELECT * FROM example WHERE id = ?').get(id) as ExampleRow | undefined;
  return row ? mapExample(row) : null;
}
```

最后在 `repositories/index.ts` 与 `src/index.ts` 里补充导出。

**约定**

- 所有函数是**纯函数风格**：`db` 作为第一个参数传入，不使用全局单例
  （`getDatabase()` 只在工具和路由层使用）
- 多步写操作包在 `db.transaction(() => { ... })()` 里
- 入参用 `input: {...}` 对象而不是长参数列表
- 解析 JSON 一律走带 `try/catch` 的辅助函数，脏数据不能让整个查询炸掉

## 5. 加一个工具

工具放在 `packages/bin-server/src/tools/`，参考
[tools/search-memory.ts](../packages/bin-server/src/tools/search-memory.ts)。

```typescript
import { getDatabase } from '@bin/db';
import type { Tool } from '@bin/core';
import type { MemoryVectors } from '../memory/vectors.js';

// 需要外部能力（如向量）的工具，用 deps 对象注入，不要在里面 new 一个 Provider：
// 工具不该自己管连接和 Key，那样每个工具都会造一份
export function createXxxTool(deps: { vectors: MemoryVectors }): Tool {
  return {
    name: 'xxx',                    // 蛇形命名，模型可读
    description: '……',              // ← 决定模型何时调用它，必须写得具体
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜索的关键词' },
      },
      required: ['keyword'],
    },
    async execute(params) {
      const keyword = String(params.keyword ?? '');
      const db = getDatabase();
      // ……查询
      return JSON.stringify({ ok: true, data: [] }, null, 2);   // 返回字符串
    },
  };
}
```

在 `packages/bin-server/src/index.ts` 里注册（deps 在那里统一创建一次）：

```typescript
agent.registerTool(createXxxTool({ vectors }));
```

**约定与注意**

- `execute` 返回**字符串**，通常用 `JSON.stringify(结果, null, 2)`——
  模型对格式化过的 JSON 理解更准
- 抛出异常即可表示失败，Agent 会捕获并转成 `tool_result` 的 `error` 字段，
  不会中断整轮对话
- 返回 `_meta.modelUsed` 字段可以标注该工具内部实际用了哪个模型
- **`description` 是工具能否被正确调用的关键**：要写清楚「什么时候该用它」，
  而不只是「它是什么」
- 单个工具结果超过 60000 字符会被截断后才喂给模型，如需完整数据给前端，
  应在结果的结构设计上把概要放在开头

## 6. 加一个 HTTP 路由

```typescript
// packages/bin-server/src/routes/xxx.ts
import type { FastifyInstance } from 'fastify';

export function registerXxxRoutes(app: FastifyInstance): void {
  app.get('/api/xxx', async () => ({ ok: true }));
}
```

在 `src/index.ts` 里调用注册函数，参数需要时把 `agent` / `config` 传进去。

SSE 场景用 `reply.hijack()` 接管响应：

```typescript
reply.hijack();
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});
reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
// …最后 reply.raw.end()
```

## 7. 调试 SSE 接口

PowerShell 下能流式看到事件（`Invoke-WebRequest` 会缓冲，看不到流式效果）：

```powershell
Add-Type -AssemblyName System.Net.Http
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(3)
$content = New-Object System.Net.Http.StringContent('{"message":"你好"}', `
  [System.Text.Encoding]::UTF8, 'application/json')
$req = New-Object System.Net.Http.HttpRequestMessage('Post', 'http://localhost:3100/api/chat/stream')
$req.Content = $content
$resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
Write-Output "HTTP $([int]$resp.StatusCode)  响应头到达: $($sw.ElapsedMilliseconds)ms"
$reader = New-Object System.IO.StreamReader($resp.Content.ReadAsStreamAsync().Result, [System.Text.Encoding]::UTF8)
while (($line = $reader.ReadLine()) -ne $null) { if ($line.Trim()) { Write-Output "[$($sw.ElapsedMilliseconds)ms] $line" } }
```

**新会话不要传 `sessionId` 字段**（省略，而不是传空字符串）。
路由用 `sessionId?.trim() || 新建` 处理，传空串也会被当成新会话，
但前端拿到回传的 `sessionId` 后必须存下来并在后续请求里带上，否则每轮都会开新会话、上下文会丢。

非流式调试用 `/api/chat/send` 更省事。

## 8. 踩坑记录

### pnpm 12 的构建脚本白名单

pnpm 12 默认不执行依赖的安装脚本，`better-sqlite3` 的原生模块不会编译。
需要在 `pnpm-workspace.yaml` 里放行：

```yaml
allowBuilds:
  better-sqlite3: true
  esbuild: true
```

> 注意：pnpm 12 已改用 `allowBuilds`（映射形式），旧的
> `onlyBuiltDependencies`（数组形式）会被忽略并自动改写成前者的占位符。

### ESM 导入必须带 `.js` 后缀

三个 packages 都用 `"module": "NodeNext"`，**相对导入必须写 `.js` 后缀**，
即使源文件是 `.ts`：

```typescript
import { runMigrations } from './migrate.js';   // ✅
import { runMigrations } from './migrate';      // ❌ 运行时报 ERR_MODULE_NOT_FOUND
```

例外：`apps/web` 用 bundler 解析，写不写后缀都行（但不要写 `.ts`）。

### better-sqlite3 编译失败

`prebuild-install` 可能因网络问题失败，此时会自动回落到 `node-gyp rebuild`，
需要本机有 Python 和 C++ 构建工具（Windows 上是 Visual Studio Build Tools）。
编译一次后会缓存，后续安装不再重复编译。

### FTS5 中文分词

`unicode61`（默认）会把整句中文识别成**一个词**，`MATCH '空压机'` 永远搜不到。
必须用 `trigram`：

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  obj_id UNINDEXED, obj_kind UNINDEXED, text, tokenize = 'trigram'
);
```

`trigram` 需要 SQLite >= 3.34，better-sqlite3 内置版本满足。
分词器在**建表时**固定，事后修改必须重建整张索引表。

### 嵌入配置不要回落到对话模型

早期 `config.ts` 里 `EMBED_BASE_URL` / `EMBED_API_KEY` 留空会回落到 `LLM_*`，
看起来是「少填一次」的便利，实际是个隐坑：两者厂商、端点、计费都不同，
回落的结果是一把只能跑对话的套餐 key 被送去打嵌入接口，
日志里只有 `404 status code (no body)`，看不出是配置问题。

现在**不做回落**：`EMBED_API_KEY` 留空就是「语义检索关闭」，
启动日志直接写出来，不会静默失败。

排查这一类问题的入口是 `GET {baseUrl}/models`——如果返回的模型列表里
一个 embedding 模型都没有，说明这把 key / 这个端点根本不提供嵌入能力。

### 卡片被长值撑成一片空白

现象：回显卡片变成几万像素高的白色空白盒子，只有标题和底部「纠正」按钮还看得见，
中间的字段/diff 全部消失。**用截图像素扫描确认过：卡片内部一个非白像素都没有**，
不是文字颜色太淡，是压根没画出来。

成因是 flex 行里的长值争夺：

```jsx
// 坏写法：四样东西挤一行
<div className="flex items-baseline gap-2">
  <span className="w-16 shrink-0">待办清单</span>
  <span className="min-w-0 shrink-0 truncate">{旧值}</span>   {/* 2500 字符、nowrap */}
  <span className="shrink-0">→</span>
  <span className="min-w-0 flex-1 break-words">{新值}</span>
</div>
```

旧值是不可换行的长串，把这一行撑爆后，新值那格被挤成接近 0 宽；
`break-words` 于是在 0 宽里**逐字换行**，行高累积成几万像素；
那些字被画在卡片可视区之外，又被卡片根节点的 `overflow-hidden` 裁掉——
于是「有高度、无内容」。

三条规则避免重演：

1. **任何承载模型输出的值都要假定它很长。** 超过 60 字符就折叠成一行预览 + 展开
2. **预览行的写法只有一种**：外层 `flex min-w-0`，值本身 `min-w-0 flex-1 truncate`。
   `shrink-0` + 长值 = 撑爆容器
3. **展开区必须有上限**：`<pre>` + `max-h-64 overflow-auto` + `break-all`
   （JSON 串没有空格，`break-words` 断不开）

顺带一提，`ToolRun.tsx` 从一开始就写对了（`min-w-0 flex-1 truncate` + `max-h-64`），
卡片是 M1 新写的、没照着抄，才踩到这个坑。

### 局域网 HTTP 下没有 WebCrypto 和剪贴板

这两个 API 只在**安全上下文**（HTTPS，或 `localhost` / `127.0.0.1`）存在，
而 `http://192.168.x.x` 不是：

| API | 在局域网 HTTP 下的表现 |
|---|---|
| `crypto.subtle`（WebCrypto） | `undefined`——整个属性不存在，不是报错 |
| `navigator.clipboard` | `undefined` |
| Service Worker | 注册失败 |

这条约束直接决定了 M4 和 M5 的形态：

- **保险箱解密放在服务端**，而不是前端。前端解密要 WebCrypto，
  而手机走局域网 HTTP 时它根本不存在——那套方案会在最需要它的场景下失效
- **M5 不做 service worker**，只做 manifest + 图标 + 加到主屏幕
- **复制密码要有兜底**：`VaultView.tsx` 里检测 `window.isSecureContext`，
  不可用时退回 `document.execCommand('copy')`（已废弃但能用）

想彻底解决就得有 HTTPS：Tailscale（能拿到 `.ts.net` 的证书）或 Cloudflare Tunnel。

### 工具结果回灌的协议

OpenAI 协议要求 assistant 轮的 `tool_calls` 与 `role: "tool"` 消息的
`tool_call_id` **成对出现**。漏掉任何一个，第二轮请求都会被接口拒绝。
具体见 [architecture.md](architecture.md#32-工具结果回灌的协议要求)。

## 9. 编码约定

- **语言**：代码注释、提示词、文档、UI 文案统一用中文
- **类型**：`strict: true`，不写 `any`（确实需要时用 `unknown` + 收窄）
- **变量名**：代码用英文（`typeId` / `occurredAt`），数据库列用蛇形（`type_id` / `occurred_at`），
  转换集中在仓储的 `mapXxx()` 函数里
- **注释**：解释「为什么这么做」，不解释「这行在做什么」。
  复杂度高或有反直觉取舍的地方必须写清楚原因
- **未使用变量**：`noUnusedLocals` / `noUnusedParameters` 已开启，
  确实要留的参数用 `_` 前缀
- 提交格式化：`pnpm format`