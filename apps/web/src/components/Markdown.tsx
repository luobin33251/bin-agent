import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 助手回复的 Markdown 渲染。
 *
 * 排版规则集中在 index.css 的 .md 下，不用 components 逐个映射元素：
 * 元素一多，JSX 会被 Tailwind 类名淹掉，改排版还得改代码。
 *
 * remark-gfm 用于支持表格、删除线、任务列表、自动链接这些 GitHub 扩展语法。
 */
export function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  return (
    <div className={streaming ? 'md is-streaming' : 'md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 外链一律新窗口打开，避免把当前对话页顶掉
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}