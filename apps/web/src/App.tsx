import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChat, type MemoryCard as MemoryCardData } from './services/chat';
import { MessageItem, type UiMessage } from './components/MessageItem';
import { Composer } from './components/Composer';
import { VaultView } from './components/VaultView';

const SUGGESTIONS = [
  '记一下：今天跟云连确认了空调 7 月 10 日付款，5 台一共 62995，发票还没开',
  '都记了哪些类别的信息？',
  '帮我找一下上次记的空调那事',
];

let messageSeq = 0;
const nextId = () => `m${++messageSeq}`;

export default function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  const [view, setView] = useState<'chat' | 'vault'>('chat');
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const patchLast = useCallback((patch: (message: UiMessage) => UiMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = patch(next[next.length - 1]);
      return next;
    });
  }, []);

  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || busy) return;

      setInput('');
      setBusy(true);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: text, preamble: '', toolCalls: [], cards: [] },
        { id: nextId(), role: 'assistant', content: '', preamble: '', toolCalls: [], cards: [], streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          { sessionId: sessionIdRef.current ?? undefined, message: text },
          (event) => {
            switch (event.type) {
              case 'session':
                sessionIdRef.current = event.sessionId;
                setSessionStarted(true);
                break;
              case 'assistant_message':
                patchLast((m) => ({ ...m, content: m.content + event.content }));
                break;
              case 'tool_call':
                // 工具调用之前模型说的话属于「中间过程」，挪进 preamble 并清空正文，
                // 否则会跟最终结论首尾拼接成一句读不通的话
                patchLast((m) => ({
                  ...m,
                  preamble: m.content ? (m.preamble ? `${m.preamble}\n${m.content}` : m.content) : m.preamble,
                  content: '',
                  toolCalls: [...m.toolCalls, event.toolCall],
                }));
                break;
              case 'tool_result':
                patchLast((m) => ({
                  ...m,
                  toolCalls: m.toolCalls.map((call) =>
                    call.id === event.toolCall.id ? { ...call, ...event.toolCall } : call,
                  ),
                }));
                break;
              case 'memory_card':
                patchLast((m) => ({ ...m, cards: [...m.cards, event.card] }));
                break;
              case 'error':
                patchLast((m) => ({ ...m, error: event.error }));
                break;
              case 'done':
                patchLast((m) => ({ ...m, streaming: false }));
                break;
              default:
                break;
            }
          },
          controller.signal,
        );
      } catch (error) {
        patchLast((m) => ({
          ...m,
          streaming: false,
          error: error instanceof Error ? error.message : '请求失败',
        }));
      } finally {
        abortRef.current = null;
        setBusy(false);
        patchLast((m) => ({ ...m, streaming: false }));
      }
    },
    [busy, input, patchLast],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 一键纠正：把一条带上下文的提示预填进输入框，用户补完就发送。
   * 不直接代用户发送——纠正内容只有用户自己知道，代发会自作主张。
   */
  const handleCorrect = useCallback((card: MemoryCardData) => {
    setInput(`刚才那条「${card.title}」记错了，应该是：`);
    setFocusSignal((n) => n + 1);
  }, []);

  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top z-10 shrink-0 border-b border-line bg-page">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-ink">bin</span>
            <span className="hidden text-[12px] text-ink-3 sm:inline">个人信息中枢</span>
          </div>

          <nav className="flex items-center gap-0.5 rounded-control border border-line bg-surface p-0.5 shadow-hairline">
            <TabButton active={view === 'chat'} onClick={() => setView('chat')}>
              对话
            </TabButton>
            <TabButton active={view === 'vault'} onClick={() => setView('vault')}>
              保险箱
            </TabButton>
          </nav>

          <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-3 sm:flex">
            {busy && (
              <span
                className="size-2.5 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                style={{ animation: 'spin 700ms linear infinite' }}
              />
            )}
            {view === 'chat' ? (sessionStarted ? '会话进行中' : '新会话') : '凭证加密存储'}
          </span>
        </div>
      </header>

      {view === 'vault' ? (
        <VaultView />
      ) : (
        <>
          <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
              {empty ? (
                <EmptyState onPick={(text) => void handleSend(text)} />
              ) : (
                messages.map((message) => (
                  <MessageItem key={message.id} message={message} onCorrect={handleCorrect} />
                ))
              )}
            </div>
          </div>

          <Composer
            value={input}
            onChange={setInput}
            onSend={() => void handleSend()}
            onStop={handleStop}
            busy={busy}
            focusSignal={focusSignal}
          />
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`rounded-[6px] px-3 py-1.5 text-[12.5px] transition-colors duration-150 sm:px-2.5 sm:py-1 ${
        active ? 'bg-inset font-medium text-ink' : 'text-ink-3 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-5 px-4 pt-16 pb-8 text-center">
      <span
        className="flex size-11 items-center justify-center rounded-window bg-surface text-accent shadow-card"
        style={{ animation: 'pop-in 400ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
      </span>

      <div className="flex flex-col gap-1.5">
        <h1 className="text-[16px] font-semibold tracking-tight text-ink">跟 bin 说点什么</h1>
        <p className="max-w-sm text-[13px] leading-[1.65] text-ink-2">
          它会判断这条信息属于哪个类别，自己建好结构再存起来。
          <span className="text-ink-3">记完会弹一张卡片，不对可以一键纠正。</span>
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5 pt-1">
        {SUGGESTIONS.map((text, index) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="flex items-center justify-between gap-2 rounded-control border border-line
              bg-surface px-3 py-2 text-left text-[13px] text-ink-2 transition-colors duration-150 hover:bg-hover"
            style={{ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${index * 70 + 120}ms both` }}
          >
            <span className="min-w-0 truncate">{text}</span>
            <span className="shrink-0 text-ink-3">↵</span>
          </button>
        ))}
      </div>
    </div>
  );
}