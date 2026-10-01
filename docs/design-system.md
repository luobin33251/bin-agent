# 界面设计体系

## 1. 来源

界面风格与组件取自 **<https://www.beautifului.dev/>** —— 一个面向 AI 原生界面的组件库，
共 21 个组件（Chat、Tool Chips、Thinking、Streaming Text、Approval Card、Prompt Bar、
Sidebar Nav、Records Table 等）。

该站点没有公开的 npm 包或 registry，但对 agent 很友好：**每个组件的完整源码都以字符串形式
内嵌在 Next.js 的 RSC flight 数据里**（页面上的 "Copy code" 按钮就复制这份源码）。
需要重新取用或参考未被采纳的组件时，按下面的方法抽取：

```js
// 1) 拉页面 HTML
//    https://www.beautifului.dev/
// 2) 拼接所有 self.__next_f.push([1,"..."]) 的参数（逐个 JSON.parse 后相接）
// 3) RSC 文本行的格式是 <id>:T<hexlen>,<content>，content 恰好 hexlen 个字符
//    用 /(?:^|\n)[0-9a-f]+:T([0-9a-f]+),/g 全局匹配，按声明的长度截取
// 4) 以 `"use client"` 开头的块就是组件源码
```

> 注意：不能用「逐行推进」的方式扫描，长度对不上会让扫描器漂移、漏掉后续代码块。
> 必须一次性全局匹配所有行前缀再逐个截取。

设计令牌在同站的 `/_next/static/css/<hash>.css` 里，按 `:root`（浅色）与 `.dark`（深色）两组定义。

## 2. 令牌体系

一套很克制的单色系统：颜色层级分明，但几乎没有彩色，彩色只用在真正需要强调的地方。

### 背景层级（从底到顶）

| 令牌 | 用途 |
|------|------|
| `--page` | 页面最底色 |
| `--canvas` | 内容画布 |
| `--surface` | 卡片、面板 |
| `--inset` | 凹陷区域（展开详情、内嵌块） |
| `--field` | 输入框、用户气泡 |
| `--hover` / `--hover-2` | 悬浮态（两级强度） |

### 文字三级

| 令牌 | 用途 |
|------|------|
| `--ink` | 主文字 |
| `--ink-2` | 次要文字、说明 |
| `--ink-3` | 最弱：占位符、元信息、图标 |

### 边框两级

`--line`（常规分隔）、`--line-strong`（需要强调的边框，如输入框聚焦前）。

### 强调与状态色

`--accent`（主强调，蓝色系）、`--green` / `--orange` / `--red`（状态）。
每个都配一个 `-tint` 后缀的浅底版本，用于标签底色。

### 圆角梯度

`--radius-chip` 6px · `--radius-control` 8px · `--radius-card` 10px · `--radius-window` 14px

### 阴影

不是模糊投影，而是 **`0 0 0 1px var(--line)` 的一圈描边 + 多层极淡投影**，
所以界面边界非常干净。共四档：`shadow-hairline` / `shadow-btn` / `shadow-card` / `shadow-raised`。

### 动效

统一用 `cubic-bezier(0.23, 1, 0.32, 1)`（`--ease-out-strong`），关键帧有
`fade-up` / `fade-in` / `pop-in` / `shimmer-text` / `spin` / `caret-blink`。
已加 `prefers-reduced-motion` 兜底。

### 字号

正文 13–13.5px、辅助 11.5–12px、标题 15–16px。比常规界面紧凑一档，这是它的观感来源之一。

## 3. 落地位置

```
apps/web/src/
├─ index.css                   设计令牌（@theme 映射 + 浅深两套 + 阴影类 + 关键帧）
├─ App.tsx                     页面组装、视图切换（对话/保险箱）、SSE 状态机、空状态
├─ services/
│  ├─ chat.ts                  SSE 调用与事件类型
│  └─ vault.ts                 保险箱接口封装
└─ components/
   ├─ icons.tsx                内联 SVG 图标集 + 按工具名选图标
   ├─ ToolRun.tsx              工具调用轨迹（Tool Chips + Thinking 的 Coding 变体）
   ├─ MemoryCard.tsx           记忆回显卡片（Approval Card）
   ├─ VaultView.tsx            保险箱页（设置主密码 / 解锁 / 凭证列表）
   ├─ Markdown.tsx             助手回复的 Markdown 渲染
   ├─ MessageItem.tsx          单条消息：用户气泡 / 中间过程 + 工具轨迹 + 卡片 + 结论
   └─ Composer.tsx             输入区（Prompt Bar 的视觉语言）
```

机制：

- **Tailwind v4**，通过 `@tailwindcss/vite` 插件接入，无 `tailwind.config.js`（v4 用 CSS 配置）
- `@theme` 把令牌映射成 Tailwind 颜色/圆角命名空间，于是可以用 `bg-surface`、`text-ink-2`、
  `border-line`、`rounded-window` 这类语义类名，而不是硬写颜色值
- 深浅色由 `<html class="dark">` 驱动，`index.html` 里一段内联脚本跟随系统设置
- 颜色令牌里大量使用 `oklch`，比 hex 更均匀，深浅色映射也更自然

## 4. 组件映射

参考站的组件是**带自播放演示的展示品**，接入时必须剥掉演示时序（`setTimeout` 驱动的
`stage`/`phase` 推进），换成真实数据驱动。已落地四个：

| 参考组件 | 落地文件 | 改造点 |
|---|---|---|
| Chat | `App.tsx` + `MessageItem.tsx` | 保留面板布局、气泡样式、输入区造型；消息改由 SSE 事件驱动 |
| Tool Chips | `ToolRun.tsx` | 去掉脚本化步骤与 diff 预览；行内容改为真实工具名 + 参数摘要，展开显示原始返回 |
| Thinking | `MessageItem.tsx` 的 `WorkingLabel` | 取其 shimmer 文字与 sparkle 图标，作为「正在整理…」的等待态 |
| Streaming Text | `MessageItem.tsx` | 取光标闪烁与正文排版；去掉引用 chip 与 follow-up（当前数据里没有） |
| Approval Card | `MemoryCard.tsx` | M1 的记忆回显卡片：头部状态 + 中部字段/diff + 底部动作 |
| Vault | `VaultView.tsx` | M4 的保险箱页：设置主密码 / 解锁 / 凭证列表 / 增删改。明文默认掩码（密码显示为圆点），点眼睛才展开，点图标复制 |
| Tab Switcher | `App.tsx` 的 `TabButton` | 对话 / 保险箱 两个视图的切换，做成一枚胶囊里的两格 |

> **卡片里的值长度不可控，必须折叠。** 字段值由模型生成，实测出现过把 22 项待办
> 整个塞进一个 `json` 字段（2500 字符）。规则：**超过 60 字符一律「一行预览 + 展开」**，
> 展开区用 `<pre>` + `max-h-64 overflow-auto` + `break-all`；
> 变更对照**竖着排**，不要「旧值 → 新值」挤一行。踩坑全过程见
> [development.md](development.md#卡片被长值撑成一片空白)。

尚未采纳但后续可能用得上的：
`Sidebar Nav`（数据视图导航）、`Records Table` / `Filter Table`（条目浏览页）、
`Loading State`（长任务等待）、`Search`（全局搜索）。

## 4.1 Markdown 渲染

模型输出的是富文本 Markdown（标题、加粗、列表、引用、表格、代码块），
必须经过渲染才能读。用 `react-markdown` + `remark-gfm`（GFM 扩展支持表格、
任务列表、删除线、自动链接）。

**排版规则集中在 `index.css` 的 `.md` 下**，不用 `components` 逐个映射元素——
元素一多 JSX 会被 Tailwind 类名淹掉，且调排版要同时改代码和样式。

两个细节：

- **流式光标**用 `.md.is-streaming > *:last-child::after` 挂伪元素，
  这样光标跟在最后一个块级元素尾部随文字流动，而不是另起一行
- 外链统一 `target="_blank"`，避免把当前对话页顶掉

代价是打包体积增加明显（JS 从 155KB 涨到 313KB，gzip 后 98KB）——
unified/remark 生态本身就重。本地应用可接受，真要优化可以换更轻的解析器
或只在有 Markdown 特征时才做解析。

## 5. 新增界面时

1. 先看 `index.css` 里的令牌，**用语义类名而不是硬写颜色**
2. 需要新色/新层级时，先在 `:root` 和 `.dark` 里各加一个令牌，再在 `@theme` 里映射
3. 圆角只用那四档，间距沿用 Tailwind 的 spacing scale，不要发明中间值
4. 进入类动效统一用 `fade-up 300ms cubic-bezier(0.23,1,0.32,1)`
5. 需要新组件时，按 §1 的方法回参考站取源码，剥掉演示逻辑后接真实数据

## 6. 两个已踩过的坑

### 阴影不能用 `@theme` 间接引用

`@theme` 会把变量输出到 `:root`，而**自定义属性里的 `var()` 在声明处就求值**。
如果写成 `--shadow-card: 0 0 0 1px var(--line), ...` 放在 `@theme` 里，
`--line` 会被冻结成 `:root` 上的浅色值，`.dark` 里改 `--line` 不会生效。

解决办法是把阴影定义成**普通 CSS 类**（`.shadow-card { box-shadow: var(--elev-card) }`），
在元素使用处求值，深色覆盖就能正常继承。颜色令牌不存在这个问题——
因为 `:root` 和 `.dark` 是同一个元素（`<html>`），替换发生在同一层。

### pnpm 12 的 lockfile 与构建脚本

- 改完 `package.json` 后 `pnpm install` 会因 frozen-lockfile 失败，需要先跑
  `pnpm install --no-frozen-lockfile` 重建 lockfile
- `better-sqlite3` 的原生模块被正在运行的 dev server 占用时，重装会因文件锁失败（`EBUSY`/`EPERM`）。
  **先停掉 `pnpm dev` 再装依赖。**