import { useEffect, useRef, type KeyboardEvent } from 'react';
import { GLYPHS, Icon } from './icons';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  focusSignal,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  /** 数值变化时把焦点抢回输入框，用于「点纠正按钮后立刻可以打字」 */
  focusSignal?: number;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !busy;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // 光标落到末尾，用户接着往下写
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusSignal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
      <div className="mx-auto w-full max-w-3xl">
        <div
          role="presentation"
          onClick={() => inputRef.current?.focus()}
          className="flex cursor-text flex-col gap-1.5 rounded-window border border-line bg-field p-2.5
            transition-[border-color,box-shadow] duration-150
            focus-within:border-line-strong focus-within:shadow-card"
        >
          <textarea
            ref={inputRef}
            value={value}
            rows={2}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="说说你记了什么，或者问点什么…"
            aria-label="对话输入"
            className="min-h-10 w-full resize-none bg-transparent text-[13.5px] leading-[1.55] text-ink
              outline-none placeholder:text-ink-3"
          />

          <div className="flex items-center justify-between">
            {/* 手机上软键盘没有 Shift，Enter 是换行，所以提示改成发送按钮 */}
            <span className="hidden text-[11.5px] text-ink-3 sm:inline">
              Enter 发送 · Shift + Enter 换行
            </span>
            <span className="text-[11.5px] text-ink-3 sm:hidden">点右侧按钮发送</span>

            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="停止生成"
                className="flex size-8 items-center justify-center rounded-control border border-line-strong
                  bg-surface text-ink-2 shadow-btn transition-transform duration-200 active:scale-[0.96] sm:size-7"
              >
                <Icon size={13} filled>
                  {GLYPHS.stop}
                </Icon>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                aria-label="发送"
                className="flex size-8 items-center justify-center rounded-control
                  transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96] sm:size-7"
                style={{
                  background: canSend ? 'var(--ink)' : 'var(--line-strong)',
                  color: canSend ? 'var(--surface)' : 'var(--ink-2)',
                }}
              >
                <Icon size={15} strokeWidth={2.4}>
                  {GLYPHS.arrowUp}
                </Icon>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}