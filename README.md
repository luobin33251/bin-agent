# bin-agent

通用个人信息中枢。通过对话录入零散信息，由 AI 自主判断类别并归档，之后通过对话调取。

> 关键设计前提：**系统不预设任何信息类型**。没有「采购表」「账号表」这类写死的结构，
> 只有通用的「条目 + 类型」模型，类型由 AI 在写入时现场创建并逐步演化。

## 当前状态

**M2 + M4 + M5 已完成**（详见 [docs/roadmap.md](docs/roadmap.md)）：

- 跟它说一段话 → 它判断类别、拆字段、落库 → 界面弹出卡片告诉你记成了什么 → 不对可一键纠正
- 类别由 AI 现场创建并复用，没有预设分类；原来的话原样留存，可追溯、可重新归类
- 调取走**关键词（FTS5）+ 语义（向量）混合检索**，用 RRF 融合。
  用户说「上次那个空调的事」这种措辞不一致的模糊提问也能找回来
- 语义检索需要配 `EMBED_API_KEY`（百炼的 `sk-` API-KEY）；
  **不配也能用**，此时自动退化为纯关键词检索，启动日志会明确提示
- **保险箱**：服务器密码、FTP 账号这类凭证单独加密存放，不参与检索、不进对话记录，
  Agent 也读不到；主密码 30 分钟无操作自动锁定
- **手机可用**：后端直接托管前端产物，手机只需访问一个地址，可「添加到主屏幕」
- 文件接入（M3）暂停中

## 快速开始

环境要求：Node.js >= 20、pnpm。

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：至少填 LLM_API_KEY（对话模型）
#            想要语义检索，再填 EMBED_API_KEY（百炼 DashScope 的 sk- API-KEY）；不填则退化为纯关键词

# 3. 初始化数据库（首次运行会自动执行，也可手动触发）
pnpm --filter @bin/db migrate

# 4. 同时启动后端(3100)与前端(5173)
pnpm dev
```

浏览器打开 <http://localhost:5173>。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 分层架构、Agent 循环、工具系统、技术选型 |
| [docs/data-model.md](docs/data-model.md) | 六张表的逐字段说明与设计理由 |
| [docs/design-system.md](docs/design-system.md) | 界面设计令牌、组件来源、如何新增界面 |
| [docs/roadmap.md](docs/roadmap.md) | M0–M5 里程碑、进度跟踪、待决策项 |
| [docs/development.md](docs/development.md) | 加迁移 / 仓储 / 工具 / 路由的实操指南与踩坑记录 |

## 目录结构

```
bin-agent/
├─ packages/
│  ├─ bin-ai/          LLM 抽象层：Provider 基类 + 对话 / 嵌入两个 OpenAI 兼容实现
│  ├─ bin-core/        Agent 核心：ReAct 循环、工具注册、会话管理
│  ├─ bin-db/          SQLite 数据层：连接、版本化迁移、仓储、检索（FTS5 + 向量 + RRF）
│  └─ bin-server/      Fastify 服务：SSE 对话接口、工具实现
├─ apps/
│  └─ web/             React 对话页
├─ data/               SQLite 数据文件与备份（已在 .gitignore 中）
└─ docs/               开发文档
```

## 常用脚本

在仓库根目录执行：

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 同时启动后端与前端 |
| `pnpm dev:server` | 只启动后端（tsx watch） |
| `pnpm dev:web` | 只启动前端（Vite） |
| `pnpm build` | 构建全部包 |
| `pnpm --filter @bin/db migrate` | 执行数据库迁移并打印 schema 清单 |
| `pnpm build:web` | 只构建前端（手机访问走 `3100`，改完前端要跑一次这个） |
| `pnpm reindex` | 回填向量索引（换嵌入模型、或怀疑索引缺条时手动跑） |
| `pnpm format` | Prettier 格式化 |

## 手机上用

服务端会托管前端产物，所以手机只需要一个地址：

```bash
pnpm build:web     # 先构建一次前端
pnpm dev:server    # 只起后端（3100 端口，监听 0.0.0.0）
```

手机浏览器打开 `http://<电脑的内网IP>:3100`（启动日志里会打印内网地址），
然后「添加到主屏幕」即可当应用用。

- 只在同一局域网内可访问；**想在外网用需要额外的隧道方案，且必须先加访问口令**
- 本地改前端代码时用电脑上的 `http://localhost:5173`（Vite 带热更新）；
  手机看到的是构建产物，改完要重新 `pnpm build:web`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 前端页面（构建产物，SPA 兜底：非 `/api` 的未知路径都回首页） |
| GET | `/health` | 健康检查 |
| POST | `/api/chat/stream` | 流式对话（SSE），请求体 `{ sessionId?, message }` |
| POST | `/api/chat/send` | 非流式对话，便于脚本化调试 |
| GET | `/api/vault/status` | 保险箱状态（是否已设置主密码、是否解锁、剩余锁定时间） |
| POST | `/api/vault/setup` | 首次设置主密码 |
| POST | `/api/vault/unlock` | 解锁（密码错返回 200 + `ok:false`） |
| POST | `/api/vault/lock` | 立即锁定 |
| GET | `/api/vault/entries` | 凭证列表（**只回 label/kind/hint，不含密文**） |
| POST | `/api/vault/entries` | 新增凭证（服务端加密后落库） |
| GET | `/api/vault/entries/:id` | 取明文（未解锁返回 401） |
| PATCH | `/api/vault/entries/:id` | 修改（只改密码时不会丢掉账号） |
| DELETE | `/api/vault/entries/:id` | 删除（硬删除） |

SSE 事件类型：`session` / `assistant_message` / `assistant_message_end` /
`tool_call` / `tool_result` / `memory_card` / `done` / `error`。

其中 `memory_card` 是路由层从工具的返回结果里识别 `_meta.card` 后补发的，
前端据此渲染记忆回显卡片。