// 保险箱接口封装。与 packages/bin-server/src/routes/vault.ts 一一对应

export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  /** 距离自动锁定还剩多少毫秒；未解锁时为 null */
  remainingMs: number | null;
  timeoutMs: number;
}

export interface VaultEntryMeta {
  id: string;
  label: string;
  kind: string | null;
  hint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface VaultEntryDetail {
  id: string;
  label: string;
  kind: string | null;
  hint: string | null;
  username: string;
  password: string;
}

export interface VaultEntryInput {
  label: string;
  kind?: string;
  username?: string;
  password?: string;
  hint?: string;
}

/** 已锁定：前端据此切回解锁界面，而不是当成普通报错弹提示 */
export class VaultLockedError extends Error {
  constructor() {
    super('保险箱已锁定');
    this.name = 'VaultLockedError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });

  if (response.status === 401) throw new VaultLockedError();

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return payload as T;
}

export const vaultApi = {
  status: () => request<VaultStatus>('/api/vault/status'),

  setup: (password: string) =>
    request<{ ok: boolean }>('/api/vault/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  unlock: (password: string) =>
    request<{ ok: boolean; error?: string }>('/api/vault/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  lock: () => request<{ ok: boolean }>('/api/vault/lock', { method: 'POST' }),

  list: () => request<{ total: number; entries: VaultEntryMeta[] }>('/api/vault/entries'),

  reveal: (id: string) => request<VaultEntryDetail>(`/api/vault/entries/${id}`),

  create: (input: VaultEntryInput) =>
    request<{ ok: boolean; id: string }>('/api/vault/entries', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (id: string, input: Partial<VaultEntryInput>) =>
    request<{ ok: boolean }>(`/api/vault/entries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  remove: (id: string) => request<{ ok: boolean }>(`/api/vault/entries/${id}`, { method: 'DELETE' }),
};