import { useCallback, useEffect, useRef, useState } from 'react';
import { GLYPHS, Icon } from './icons';
import {
  VaultLockedError,
  vaultApi,
  type VaultEntryInput,
  type VaultEntryMeta,
  type VaultStatus,
} from '../services/vault';

/**
 * 保险箱页。
 *
 * 三层状态：没设过主密码 → 设置；设过但锁着 → 解锁；解锁后 → 列表。
 * 三种状态各自占满视图，不做局部切换——凭证页最怕的就是「以为锁着其实没锁」。
 */
export function VaultView() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [notice, setNotice] = useState('');

  const refreshStatus = useCallback(async () => {
    try {
      const next = await vaultApi.status();
      setStatus(next);
      return next;
    } catch (error) {
      setNotice(message(error));
      return null;
    }
  }, []);

  const refreshEntries = useCallback(async () => {
    try {
      const { entries: rows } = await vaultApi.list();
      setEntries(rows);
    } catch (error) {
      if (error instanceof VaultLockedError) {
        setEntries([]);
        await refreshStatus();
        return;
      }
      setNotice(message(error));
    }
  }, [refreshStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.unlocked) void refreshEntries();
  }, [status?.unlocked, refreshEntries]);

  // 服务端会在超时后自动锁定，前端定期对齐状态，避免「界面还开着但接口已经拒绝」
  useEffect(() => {
    if (!status?.unlocked) return;
    const timer = window.setInterval(() => {
      void refreshStatus().then((next) => {
        if (next && !next.unlocked) {
          setEntries([]);
          setNotice('已自动锁定：超过 30 分钟没有操作。');
        }
      });
    }, 20000);
    return () => window.clearInterval(timer);
  }, [status?.unlocked, refreshStatus]);

  if (!status) {
    return <p className="px-4 py-10 text-center text-[12.5px] text-ink-3">正在读取保险箱状态…</p>;
  }

  if (!status.configured) {
    return (
      <Gate
        title="设置主密码"
        description="保险箱里的凭证用主密码加密存储，服务端不保存主密码本身。"
        submitLabel="设置并解锁"
        notice={notice}
        onNotice={setNotice}
        onSubmit={async (password) => {
          await vaultApi.setup(password);
          const next = await refreshStatus();
          if (next?.unlocked) await refreshEntries();
        }}
      >
        <div className="flex flex-col gap-1 rounded-control border border-line bg-orange-tint px-3 py-2">
          <span className="text-[12.5px] font-medium text-ink">主密码忘了就解不开了</span>
          <span className="text-[11.5px] leading-[1.55] text-ink-2">
            没有找回入口，也没有后门——这是加密本身的代价。请用一个你确定记得住、又足够长的密码。
          </span>
        </div>
      </Gate>
    );
  }

  if (!status.unlocked) {
    return (
      <Gate
        title="保险箱已锁定"
        description="输入主密码解锁。30 分钟没有操作会自动重新锁上。"
        submitLabel="解锁"
        notice={notice}
        onNotice={setNotice}
        onSubmit={async (password) => {
          const result = await vaultApi.unlock(password);
          if (!result.ok) throw new Error(result.error ?? '主密码不对');
          const next = await refreshStatus();
          if (next?.unlocked) await refreshEntries();
        }}
      />
    );
  }

  return (
    <VaultList
      entries={entries}
      notice={notice}
      onNotice={setNotice}
      onChanged={refreshEntries}
      onLocked={() => {
        setEntries([]);
        void refreshStatus();
      }}
      onLock={async () => {
        await vaultApi.lock();
        setEntries([]);
        await refreshStatus();
      }}
    />
  );
}

/** 设置主密码 / 解锁，两个界面只有文案和请求不同，合成一个组件 */
function Gate({
  title,
  description,
  submitLabel,
  notice,
  onNotice,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  notice: string;
  onNotice: (text: string) => void;
  onSubmit: (password: string) => Promise<void>;
  children?: React.ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const needsConfirm = submitLabel.includes('设置');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    onNotice('');

    if (needsConfirm && password !== confirm) {
      onNotice('两次输入的主密码不一致');
      return;
    }

    setBusy(true);
    try {
      await onSubmit(password);
      setPassword('');
      setConfirm('');
    } catch (error) {
      onNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-10">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-3.5 rounded-card border border-line bg-surface p-4 shadow-card"
        style={{ animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
            <Icon size={15} strokeWidth={2}>
              {GLYPHS.lock}
            </Icon>
            {title}
          </span>
          <span className="text-[12px] leading-[1.6] text-ink-2">{description}</span>
        </div>

        {children}

        <div className="flex flex-col gap-2">
          <Field label="主密码">
            <input
              type="password"
              value={password}
              autoFocus
              autoComplete={needsConfirm ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-control border border-line bg-field px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-line-strong"
            />
          </Field>

          {needsConfirm && (
            <Field label="再输一次">
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
                className="w-full rounded-control border border-line bg-field px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-line-strong"
              />
            </Field>
          )}
        </div>

        {notice && <span className="text-[12px] text-red">{notice}</span>}

        <button
          type="submit"
          disabled={busy || !password}
          className="rounded-control bg-accent px-3 py-1.5 text-[13px] font-medium text-white
            transition-opacity duration-150 disabled:opacity-40"
        >
          {busy ? '处理中…' : submitLabel}
        </button>
      </form>
    </div>
  );
}

function VaultList({
  entries,
  notice,
  onNotice,
  onChanged,
  onLock,
  onLocked,
}: {
  entries: VaultEntryMeta[];
  notice: string;
  onNotice: (text: string) => void;
  onChanged: () => Promise<void>;
  onLock: () => Promise<void>;
  onLocked: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fail = (error: unknown) => {
    if (error instanceof VaultLockedError) {
      onLocked();
      return;
    }
    onNotice(message(error));
  };

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12.5px] text-ink-3">
            共 {entries.length} 条凭证 · 30 分钟无操作自动锁定
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                onNotice('');
              }}
              className="flex items-center gap-1 rounded-control border border-line bg-surface px-2 py-1
                text-[12.5px] text-ink-2 shadow-hairline transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <Icon size={13} strokeWidth={2.2}>
                {GLYPHS.plus}
              </Icon>
              新增凭证
            </button>
            <button
              type="button"
              onClick={() => void onLock()}
              className="flex items-center gap-1 rounded-control border border-line bg-surface px-2 py-1
                text-[12.5px] text-ink-2 shadow-hairline transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              <Icon size={13} strokeWidth={2.2}>
                {GLYPHS.lock}
              </Icon>
              锁定
            </button>
          </span>
        </div>

        {notice && (
          <span className="rounded-control border border-line bg-red-tint px-2.5 py-1.5 text-[12px] text-ink">
            {notice}
          </span>
        )}

        {creating && (
          <EntryForm
            submitLabel="保存"
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              try {
                await vaultApi.create(input);
                setCreating(false);
                onNotice('');
                await onChanged();
              } catch (error) {
                fail(error);
              }
            }}
          />
        )}

        {entries.length === 0 && !creating && (
          <div className="rounded-card border border-line bg-surface px-4 py-10 text-center shadow-card">
            <p className="text-[13px] text-ink-2">保险箱还是空的</p>
            <p className="mt-1 text-[12px] text-ink-3">
              把服务器密码、FTP 账号这类东西存在这里，它们不参与检索、也不会进对话记录。
            </p>
          </div>
        )}

        {entries.map((entry) => (
          <div key={entry.id} className="rounded-card border border-line bg-surface shadow-card">
            {editingId === entry.id ? (
              <div className="p-2.5">
                <EntryForm
                  initial={entry}
                  submitLabel="保存修改"
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (input) => {
                    try {
                      await vaultApi.update(entry.id, input);
                      setEditingId(null);
                      onNotice('');
                      await onChanged();
                    } catch (error) {
                      fail(error);
                    }
                  }}
                />
              </div>
            ) : (
              <EntryRow
                entry={entry}
                open={openId === entry.id}
                onToggle={() => {
                  setOpenId(openId === entry.id ? null : entry.id);
                  onNotice('');
                }}
                onFail={fail}
                onEdit={() => {
                  setEditingId(entry.id);
                  setOpenId(null);
                }}
                onDelete={async () => {
                  if (!window.confirm(`删除「${entry.label}」？这条凭证会被永久移除，无法恢复。`)) return;
                  try {
                    await vaultApi.remove(entry.id);
                    await onChanged();
                  } catch (error) {
                    fail(error);
                  }
                }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 单条凭证：点开才去解密，收起时页面上不存在任何明文 */
function EntryRow({
  entry,
  open,
  onToggle,
  onEdit,
  onDelete,
  onFail,
}: {
  entry: VaultEntryMeta;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFail: (error: unknown) => void;
}) {
  const [detail, setDetail] = useState<{ username: string; password: string } | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);
  const [copied, setCopied] = useState('');
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    void vaultApi
      .reveal(entry.id)
      .then((data) => setDetail({ username: data.username, password: data.password }))
      .catch(onFail);
  }, [open, entry.id, onFail]);

  const copy = async (text: string, tag: string) => {
    const ok = await copyText(text);
    setCopied(ok ? tag : '复制失败');
    window.setTimeout(() => setCopied(''), 1600);
  };

  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="shrink-0 text-ink" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
          <Icon size={13} strokeWidth={2.2}>
            {GLYPHS.chevronRight}
          </Icon>
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{entry.label}</span>
        {entry.kind && (
          <span className="shrink-0 rounded-full bg-inset px-1.5 py-0.5 text-[11px] text-ink-2">
            {entry.kind}
          </span>
        )}
        {entry.hint && (
          <span className="hidden max-w-[40%] shrink-0 truncate text-[11.5px] text-ink-3 sm:block">
            {entry.hint}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          {!detail ? (
            <span className="text-[12px] text-ink-3">解密中…</span>
          ) : (
            <>
              <SecretRow
                label="账号"
                value={detail.username || '(无)'}
                onCopy={() => void copy(detail.username, '账号')}
              />
              <SecretRow
                label="密码"
                value={detail.password}
                masked={!revealPassword}
                onToggleMask={() => setRevealPassword((value) => !value)}
                onCopy={() => void copy(detail.password, '密码')}
              />

              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded-chip border border-line px-2 py-1 text-[12px] text-ink-2
                    transition-colors duration-150 hover:bg-hover hover:text-ink"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  className="flex items-center gap-1 rounded-chip border border-line px-2 py-1 text-[12px]
                    text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-red"
                >
                  <Icon size={12} strokeWidth={2}>
                    {GLYPHS.trash}
                  </Icon>
                  删除
                </button>
                {copied && <span className="text-[11.5px] text-green">{copied}已复制</span>}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function SecretRow({
  label,
  value,
  masked = false,
  onToggleMask,
  onCopy,
}: {
  label: string;
  value: string;
  masked?: boolean;
  onToggleMask?: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
        {masked ? '••••••••••' : value}
      </span>
      {onToggleMask && (
        <button
          type="button"
          onClick={onToggleMask}
          title={masked ? '显示' : '隐藏'}
          className="shrink-0 rounded-chip p-1.5 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink sm:p-1"
        >
          <Icon size={13} strokeWidth={2}>
            {masked ? GLYPHS.eye : GLYPHS.eyeOff}
          </Icon>
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        title="复制"
        className="shrink-0 rounded-chip p-1.5 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink sm:p-1"
      >
        <Icon size={13} strokeWidth={2}>
          {GLYPHS.copy}
        </Icon>
      </button>
    </div>
  );
}

function EntryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: VaultEntryMeta;
  submitLabel: string;
  onSubmit: (input: VaultEntryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [kind, setKind] = useState(initial?.kind ?? '');
  const [hint, setHint] = useState(initial?.hint ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 编辑时不回显原密码（取回明文只为显示，不该出现在表单里被误改）；
  // 留空表示不动原值，接口侧会自己合并
  useEffect(() => {
    if (!editing) return;
    void vaultApi
      .reveal(initial!.id)
      .then((data) => {
        setUsername(data.username ?? '');
      })
      .catch(() => undefined);
  }, [editing, initial]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (!label.trim()) {
      setError('名称不能为空');
      return;
    }
    if (!editing && !password) {
      setError('密码不能为空');
      return;
    }

    setBusy(true);
    try {
      await onSubmit({
        label: label.trim(),
        kind: kind.trim(),
        hint: hint.trim(),
        username,
        ...(password ? { password } : {}),
      });
    } catch (submitError) {
      setError(message(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3 shadow-card"
      style={{ animation: 'fade-up 260ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="名称">
          <TextInput value={label} onChange={setLabel} placeholder="如：ERP 服务器" />
        </Field>
        <Field label="类型">
          <TextInput value={kind} onChange={setKind} placeholder="如：服务器 / FTP / 银行" />
        </Field>
        <Field label="账号">
          <TextInput value={username} onChange={setUsername} placeholder="登录用户名" />
        </Field>
        <Field label={editing ? '密码（留空不改）' : '密码'}>
          <TextInput value={password} onChange={setPassword} type="password" placeholder="登录密码" />
        </Field>
      </div>

      <Field label="备注">
        <TextInput value={hint} onChange={setHint} placeholder="如：仅内网可访问" />
      </Field>

      {error && <span className="text-[12px] text-red">{error}</span>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-control bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white
            transition-opacity duration-150 disabled:opacity-40"
        >
          {busy ? '保存中…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control border border-line px-3 py-1.5 text-[12.5px] text-ink-2
            transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          取消
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-control border border-line bg-field px-2.5 py-1.5 text-[13px] text-ink
        outline-none transition-colors duration-150 placeholder:text-ink-3 focus:border-line-strong"
    />
  );
}

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS / localhost）存在——
 * 手机通过局域网 IP 访问时它是 undefined，所以必须有兜底，
 * 否则保险箱最常见的动作「复制密码」在最需要它的场景下反而失效。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}