import type { MemoryCard as MemoryCardData, ToolCallInfo } from '../services/chat';
import { Markdown } from './Markdown';
import { MemoryCard } from './MemoryCard';
import { ToolRun } from './ToolRun';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 工具调用之前的中间过程文字，与最终结论分开显示 */
  preamble: string;
  toolCalls: ToolCallInfo[];
  cards: MemoryCardData[];
  error?: string;
  streaming?: boolean;
}

/** 工作中的提示：用参考站的 shimmer 文字，而不是转圈图标 */
function WorkingLabel() {
  return (
    <span
      className="bg-clip-text text-[13px] font-medium text-transparent"
      style={{
        backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer-text 1.4s linear infinite',
      }}
    >
      正在整理…
    </span>
  );
}

export function MessageItem({
  message,
  onCorrect,
}: {
  message: UiMessage;
  onCorrect: (card: MemoryCardData) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end pl-10" style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}>
        <div className="max-w-[85%] rounded-card bg-field px-3 py-2 text-[13.5px] leading-[1.6] text-ink shadow-hairline whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  const waiting = message.streaming && !message.content && !message.preamble && message.toolCalls.length === 0;

  return (
    <div className="flex flex-col gap-2" style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}>
      {/* 中间过程：模型在调工具之前说的话，压暗显示，不跟结论混在一起 */}
      {message.preamble && (
        <p className="text-[12.5px] leading-[1.6] text-ink-3 whitespace-pre-wrap break-words">
          {message.preamble}
        </p>
      )}

      {message.toolCalls.length > 0 && <ToolRun tools={message.toolCalls} />}

      {/* 卡片按发生顺序排在工具轨迹之后、结论文本之前 */}
      {message.cards.length > 0 && (
        <div className="flex flex-col gap-2">
          {message.cards.map((card, index) => (
            <MemoryCard key={`${card.itemId}-${card.kind}-${index}`} card={card} onCorrect={onCorrect} />
          ))}
        </div>
      )}

      {waiting && <WorkingLabel />}

      {message.content && <Markdown streaming={message.streaming}>{message.content}</Markdown>}

      {message.error && (
        <div className="rounded-control border border-line bg-red-tint px-2.5 py-2 text-[12.5px] leading-[1.55] text-ink">
          <span className="font-medium text-red">出错了：</span>
          {message.error}
        </div>
      )}
    </div>
  );
}