import { useState } from 'react';
import type { ToolCallInfo } from '../services/chat';
import { GLYPHS, Icon, glyphForTool } from './icons';

/** 把工具参数压成一行可读的摘要，如 `keyword=空调 · limit=5` */
function summarizeArgs(args: Record<string, unknown>): string | null {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

export function ToolRun({ tools }: { tools: ToolCallInfo[] }) {
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const running = tools.filter((t) => !t.result && !t.error).length;
  const failed = tools.filter((t) => t.error).length;

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="w-full" style={{ animation: 'fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}>
      {/* 折叠头：一次 Agent 运行里的全部工具调用 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1
          text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        {running > 0 ? (
          <span
            className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
            style={{ animation: 'spin 700ms linear infinite' }}
          />
        ) : (
          <span className="text-ink-3">
            <Icon size={13} strokeWidth={2.5}>
              {GLYPHS.check}
            </Icon>
          </span>
        )}
        <span className="font-medium">{tools.length} 次工具调用</span>
        {running > 0 && <span className="text-ink-3">进行中</span>}
        {failed > 0 && <span className="text-red">{failed} 个失败</span>}
        <span
          className="text-ink-3 transition-transform duration-300"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          <Icon size={13} strokeWidth={2.2}>
            {GLYPHS.chevronDown}
          </Icon>
        </span>
      </button>

      {/* 展开区：垂直时间线 + 每行可再展开看原始结果 */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span aria-hidden className="absolute left-[3px] top-0 bottom-2 w-px bg-line" />
            <div className="flex flex-col gap-0.5 py-1">
              {tools.map((tool, index) => {
                const expanded = openRows.has(tool.id);
                const args = summarizeArgs(tool.arguments);
                const pending = !tool.result && !tool.error;
                const detail = tool.error ?? tool.result;

                return (
                  <div key={tool.id} style={{ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${index * 60}ms both` }}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleRow(tool.id)}
                      className={`group flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left
                        transition-colors duration-150 ${expanded ? 'bg-inset' : 'hover:bg-hover'}`}
                    >
                      <span className={tool.error ? 'shrink-0 text-red' : 'shrink-0 text-ink-3'}>
                        <Icon size={13} strokeWidth={2}>
                          {GLYPHS[glyphForTool(tool.name)]}
                        </Icon>
                      </span>

                      <span className="shrink-0 font-mono text-[12px] font-medium text-ink">{tool.name}</span>

                      {args && (
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-3">{args}</span>
                      )}
                      {!args && <span className="flex-1" />}

                      {pending ? (
                        <span
                          className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                          style={{ animation: 'spin 700ms linear infinite' }}
                        />
                      ) : tool.error ? (
                        <span className="shrink-0 text-[11.5px] text-red">失败</span>
                      ) : (
                        <span className="shrink-0 text-[11.5px] text-ink-3">{formatBytes(tool.result!.length)}</span>
                      )}

                      <span
                        className="shrink-0 text-ink-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100
                          group-focus-visible:opacity-100"
                        style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)' }}
                      >
                        <Icon size={12} strokeWidth={2.2}>
                          {GLYPHS.chevronRight}
                        </Icon>
                      </span>
                    </button>

                    {expanded && detail && (
                      <pre
                        className="mt-1 mb-1.5 max-h-64 overflow-auto rounded-chip border border-line bg-surface
                          px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-all text-ink-2"
                        style={{ animation: 'fade-in 200ms ease-out both' }}
                      >
                        {detail}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(length: number): string {
  if (length < 1000) return `${length} 字符`;
  return `${(length / 1000).toFixed(1)}k 字符`;
}