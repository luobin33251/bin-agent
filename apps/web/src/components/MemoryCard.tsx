import { useState } from 'react';
import type { MemoryCard as MemoryCardData } from '../services/chat';

// 四种动作用状态点颜色 + 文案区分。颜色只用在圆点上，卡片底色保持中性
const KIND_META: Record<MemoryCardData['kind'], { label: string; tone: string }> = {
  saved: { label: '已记录', tone: 'var(--green)' },
  corrected: { label: '已纠正', tone: 'var(--accent)' },
  merged: { label: '已合并', tone: 'var(--accent)' },
  deleted: { label: '已删除', tone: 'var(--red)' },
  restored: { label: '已恢复', tone: 'var(--green)' },
};

/**
 * 记忆回显卡片。
 *
 * 参考 beautifului.dev 的 Approval Card / Recommendation Card：
 * 头部给状态，中部给「这次到底改成了什么」，底部给可执行动作。
 * 之所以做成结构化组件而不是让模型写进正文，是因为字段值要能被准确阅读和点选纠正，
 * 混在 Markdown 里既对不齐也点不了。
 */
export function MemoryCard({
  card,
  onCorrect,
}: {
  card: MemoryCardData;
  onCorrect: (card: MemoryCardData) => void;
}) {
  const meta = KIND_META[card.kind] ?? KIND_META.saved;
  const deleted = card.kind === 'deleted';
  const unsure = card.kind === 'saved' && card.confidence !== undefined && card.confidence < 0.6;

  return (
    <div
      className="overflow-hidden rounded-card border border-line bg-surface shadow-card"
      style={{
        animation: 'fade-up 340ms cubic-bezier(0.23,1,0.32,1) both',
        opacity: deleted ? 0.75 : 1,
      }}
    >
      {/* 头部：状态 + 类别 */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: meta.tone }} />
          <span className="text-[12px] font-medium text-ink">{meta.label}</span>
        </span>

        <span className="flex min-w-0 items-center gap-1.5">
          {card.typeIsNew && (
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium"
              style={{ background: 'var(--accent-tint)', color: 'var(--accent-ink)' }}
            >
              新建类别
            </span>
          )}
          <span className="truncate rounded-full bg-inset px-1.5 py-0.5 text-[11px] text-ink-2">
            {card.typeName}
          </span>
        </span>
      </div>

      {/* 主体：加 max-height + 内部滚动兜底。
          字段值可能很长（实测出现过 2500 字符的 JSON 清单），
          不设上限的话一次长值就能把卡片撑成一屏空白。 */}
      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span
            className="text-[13.5px] font-medium leading-[1.4] text-ink"
            style={deleted ? { textDecoration: 'line-through', color: 'var(--ink-2)' } : undefined}
          >
            {card.title}
          </span>
          {card.summary && <span className="text-[12px] leading-[1.5] text-ink-2">{card.summary}</span>}
        </div>

        {card.kind === 'corrected' ? (
          <ChangeList card={card} />
        ) : (
          card.fields.length > 0 && <FieldList card={card} />
        )}

        {card.mergedFrom && (
          <span className="text-[11.5px] text-ink-3">已并入「{card.mergedFrom}」的字段</span>
        )}

        {card.relationCount > 0 && (
          <span className="text-[11.5px] text-ink-3">关联了 {card.relationCount} 条记录</span>
        )}

        {unsure && (
          <span className="text-[11.5px]" style={{ color: 'var(--orange)' }}>
            这次归类我把握不大，如果不对请点纠正
          </span>
        )}
      </div>

      {/* 底部动作：已删除的记录只保留「纠正」，语义上是"改主意了" */}
      <div className="flex items-center gap-1.5 border-t border-line px-3 py-2">
        <button
          type="button"
          onClick={() => onCorrect(card)}
          className="rounded-chip border border-line px-2 py-1 text-[12px] text-ink-2
            transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          {deleted ? '撤销删除' : '纠正'}
        </button>
      </div>
    </div>
  );
}

/** 超过这个长度就不再铺开显示，改成「一行预览 + 展开」 */
const PREVIEW_LIMIT = 60;

/**
 * 长值的展示方式：预览一行 + 展开。
 *
 * 为什么必须有这一层：字段值是由模型生成的，长度不可控。
 * 实测出现过把 22 项待办清单整个塞进一个 json 字段（2500 字符），
 * 卡片里直接铺出来就是几百行，一眼看过去全是空白。
 *
 * 展开时用 `<pre>` + `whitespace-pre-wrap break-all`：
 * JSON 串里没有空格，只有 break-all 才断得开。
 */
function CollapsibleValue({ value, tone }: { value: string; tone?: 'from' | 'to' }) {
  const [open, setOpen] = useState(false);

  const toneClass =
    tone === 'from' ? 'text-ink-3 line-through' : tone === 'to' ? 'font-medium text-ink' : 'text-ink';

  if (value.length <= PREVIEW_LIMIT) {
    return <span className={`min-w-0 break-words ${toneClass}`}>{value}</span>;
  }

  if (open) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <pre
          className="max-h-64 overflow-auto rounded-chip border border-line bg-inset px-2 py-1.5
            font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-all text-ink-2"
        >
          {prettyValue(value)}
        </pre>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="self-start text-[11.5px] text-ink-3 transition-colors duration-150 hover:text-ink"
        >
          收起
        </button>
      </div>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className={`min-w-0 flex-1 truncate ${toneClass}`}>{value}</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 text-[11.5px] text-ink-3 transition-colors duration-150 hover:text-ink"
      >
        展开
      </button>
    </span>
  );
}

/** 值是 JSON 时格式化后再展开，否则原样显示 */
function prettyValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function FieldList({ card }: { card: MemoryCardData }) {
  return (
    <div className="flex flex-col gap-1">
      {card.fields.map((field, index) => (
        <div key={`${field.label}-${index}`} className="flex gap-3 text-[12.5px] leading-[1.5]">
          <span className="w-16 shrink-0 text-ink-3">{field.label}</span>
          <CollapsibleValue value={field.value} />
        </div>
      ))}
    </div>
  );
}

/**
 * 变更前后对照。
 *
 * 刻意**竖着排**（旧值一行、新值一行）而不是「旧值 → 新值」挤一行：
 * 挤一行时，旧值是不可换行的长串，会把新值那格挤成接近 0 宽，
 * 新值于是逐字换行，行高累积成几万像素——实测就是这么把卡片撑爆的。
 */
function ChangeList({ card }: { card: MemoryCardData }) {
  if (!card.changes || card.changes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {card.changes.map((change, index) => (
        <div key={`${change.label}-${index}`} className="flex flex-col gap-1 text-[12.5px] leading-[1.5]">
          <span className="text-ink-3">{change.label}</span>
          <div className="flex gap-2">
            <span className="w-8 shrink-0 text-ink-3">旧</span>
            <CollapsibleValue value={change.from} tone="from" />
          </div>
          <div className="flex gap-2">
            <span className="w-8 shrink-0 text-ink-3">新</span>
            <CollapsibleValue value={change.to} tone="to" />
          </div>
        </div>
      ))}
    </div>
  );
}