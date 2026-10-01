import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createVaultEntry,
  deleteVaultEntry,
  getDatabase,
  getVaultEntry,
  listVaultEntries,
  updateVaultEntry,
} from '@bin/db';
import * as vault from '../vault/session.js';

interface SetupBody {
  password: string;
}

interface SaveBody {
  label?: string;
  kind?: string;
  username?: string;
  password?: string;
  hint?: string;
}

/** 未解锁时统一返回 401，前端据此弹解锁框，而不是当成普通错误 */
function locked(reply: FastifyReply) {
  return reply.status(401).send({ error: '保险箱已锁定，请先解锁' });
}

/**
 * 保险箱接口。
 *
 * 这一层是**唯一**能拿到凭证明文的地方，三条纪律：
 * 1. 明文只进内存和响应体，不写数据库（库里只有密文，鉴权由数据层保证——它压根没有明文参数）
 * 2. 不写 entries（对话原话表），不写 search_index
 * 3. 请求体不进日志（Fastify 默认只记录方法/路径/状态码，不记 body）
 */
export function registerVaultRoutes(app: FastifyInstance): void {
  app.get('/api/vault/status', async () => vault.getStatus());

  app.post<{ Body: SetupBody }>('/api/vault/setup', async (request, reply) => {
    const password = String(request.body?.password ?? '');
    if (password.length < 6) {
      return reply.status(400).send({ error: '主密码至少 6 位' });
    }

    try {
      vault.setup(password);
    } catch (error) {
      return reply.status(400).send({ error: message(error) });
    }

    return { ok: true, ...vault.getStatus() };
  });

  app.post<{ Body: SetupBody }>('/api/vault/unlock', async (request, reply) => {
    const password = String(request.body?.password ?? '');
    if (!password) return reply.status(400).send({ error: '主密码不能为空' });

    try {
      // 密码错误返回 200 + ok:false：这是业务结果，不是服务器故障，
      // 用 401 会和「已锁定」混在一起，前端没法区分
      if (!vault.unlock(password)) {
        return { ok: false, error: '主密码不对' };
      }
    } catch (error) {
      return reply.status(400).send({ error: message(error) });
    }

    return { ok: true, ...vault.getStatus() };
  });

  app.post('/api/vault/lock', async () => {
    vault.lock();
    return { ok: true, ...vault.getStatus() };
  });

  // 列表只给元信息（label/kind/hint），不解密——少传一次明文就少一个泄漏面
  app.get('/api/vault/entries', async () => {
    const entries = listVaultEntries(getDatabase());
    return { total: entries.length, entries };
  });

  app.get<{ Params: { id: string } }>('/api/vault/entries/:id', async (request, reply) => {
    const entry = getVaultEntry(getDatabase(), request.params.id);
    if (!entry) return reply.status(404).send({ error: '找不到这条凭证' });

    try {
      // 账号和密码是同一条密文里的 JSON：GCM 的 iv 绝不能复用，
      // 两个字段各加密一次就得各配一个 iv，而表里只有一套 iv/auth_tag 列。
      // 所以一次加密两个字段，读的时候一起解回来。
      const secret = JSON.parse(
        vault.decryptValue({ cipher: entry.cipher, iv: entry.iv, authTag: entry.authTag! }),
      ) as { username?: string; password?: string };

      return {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        hint: entry.hint,
        username: secret.username ?? '',
        password: secret.password ?? '',
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    } catch (error) {
      if (isLocked(error)) return locked(reply);
      throw error;
    }
  });

  app.post<{ Body: SaveBody }>('/api/vault/entries', async (request, reply) => {
    const body = request.body ?? {};
    const label = String(body.label ?? '').trim();
    const password = String(body.password ?? '');

    if (!label) return reply.status(400).send({ error: '名称不能为空' });
    if (!password) return reply.status(400).send({ error: '密码不能为空' });

    try {
      const db = getDatabase();
      // 用户名和密码共用一条记录的 iv/authTag：一次加密两个字段、
      // 分成两条密文又会多存一套 iv，没必要
      const secret = vault.encryptValue(JSON.stringify({ username: String(body.username ?? ''), password }));
      const entry = createVaultEntry(db, {
        label,
        kind: body.kind?.trim() || null,
        hint: body.hint?.trim() || null,
        cipher: secret.cipher,
        iv: secret.iv,
        authTag: secret.authTag,
      });

      return { ok: true, id: entry.id };
    } catch (error) {
      if (isLocked(error)) return locked(reply);
      throw error;
    }
  });

  app.patch<{ Params: { id: string }; Body: SaveBody }>(
    '/api/vault/entries/:id',
    async (request, reply) => {
      const db = getDatabase();
      const id = request.params.id;
      const existing = getVaultEntry(db, id);
      if (!existing) return reply.status(404).send({ error: '找不到这条凭证' });

      const body = request.body ?? {};
      const patch: Parameters<typeof updateVaultEntry>[2] = {};

      if (body.label !== undefined) {
        const label = String(body.label).trim();
        if (!label) return reply.status(400).send({ error: '名称不能为空' });
        patch.label = label;
      }
      if (body.kind !== undefined) patch.kind = String(body.kind).trim() || null;
      if (body.hint !== undefined) patch.hint = String(body.hint).trim() || null;

      // 只改了用户名或密码时才重新加密：解密 → 合并 → 加密，避免丢掉另一个字段
      if (body.username !== undefined || body.password !== undefined) {
        try {
          const current = JSON.parse(
            vault.decryptValue({ cipher: existing.cipher, iv: existing.iv, authTag: existing.authTag! }),
          ) as { username?: string; password?: string };

          const next = JSON.stringify({
            username: body.username !== undefined ? String(body.username) : (current.username ?? ''),
            password: body.password !== undefined ? String(body.password) : (current.password ?? ''),
          });

          if (!body.password && !current.password) {
            return reply.status(400).send({ error: '密码不能为空' });
          }

          const secret = vault.encryptValue(next);
          patch.cipher = secret.cipher;
          patch.iv = secret.iv;
          patch.authTag = secret.authTag;
        } catch (error) {
          if (isLocked(error)) return locked(reply);
          throw error;
        }
      }

      updateVaultEntry(db, id, patch);
      return { ok: true, id };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/vault/entries/:id', async (request, reply) => {
    const removed = deleteVaultEntry(getDatabase(), request.params.id);
    if (!removed) return reply.status(404).send({ error: '找不到这条凭证' });
    return { ok: true };
  });
}

function isLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes('保险箱已锁定');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}