import { getDatabase, getMeta, setMeta } from '@bin/db';
import {
  createSalt,
  decrypt,
  deriveKey,
  encrypt,
  makeCheck,
  packEncrypted,
  unpackEncrypted,
  verifyKey,
  type EncryptedValue,
} from './crypto.js';

const META_SALT = 'vault.kdf.salt';
const META_CHECK = 'vault.check';

/**
 * 自动锁定时间。
 *
 * 为什么必须有：解锁后密钥留在进程内存里，如果一直不解锁，
 * 任何能访问到这个服务的人（比如手机丢了、局域网里别人打开）都能直接读明文。
 * 30 分钟是「一次查看凭证的会话足够用」和「忘了锁也不至于长期敞开」的折中。
 */
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export interface VaultStatus {
  /** 是否已经设置过主密码 */
  configured: boolean;
  unlocked: boolean;
  /** 距离自动锁定还剩多少毫秒；未解锁时为 null */
  remainingMs: number | null;
  /** 自动锁定窗口总长度，供前端显示 */
  timeoutMs: number;
}

// 解锁状态放在进程内存里，不落盘、不进日志、不随数据库走
let unlockedKey: Buffer | null = null;
let lastTouchedAt = 0;

export function getStatus(): VaultStatus {
  expireIfIdle();
  const configured = getMeta(getDatabase(), META_SALT) !== null;

  return {
    configured,
    unlocked: unlockedKey !== null,
    remainingMs: unlockedKey ? Math.max(0, LOCK_TIMEOUT_MS - (Date.now() - lastTouchedAt)) : null,
    timeoutMs: LOCK_TIMEOUT_MS,
  };
}

/** 首次设置主密码。已经设置过就拒绝，避免误操作把旧数据变成永久解不开的乱码 */
export function setup(password: string): void {
  const db = getDatabase();
  if (getMeta(db, META_SALT) !== null) {
    throw new Error('主密码已经设置过了。要解锁请用解锁接口，忘记密码则数据无法恢复。');
  }

  const salt = createSalt();
  const key = deriveKey(password, salt);

  setMeta(db, META_SALT, salt.toString('base64'));
  setMeta(db, META_CHECK, packEncrypted(makeCheck(key)));

  unlockedKey = key;
  lastTouchedAt = Date.now();
}

export function unlock(password: string): boolean {
  const db = getDatabase();
  const saltRaw = getMeta(db, META_SALT);
  const checkRaw = getMeta(db, META_CHECK);
  if (!saltRaw || !checkRaw) {
    throw new Error('还没有设置主密码');
  }

  const key = deriveKey(password, Buffer.from(saltRaw, 'base64'));
  if (!verifyKey(key, unpackEncrypted(checkRaw))) {
    return false;
  }

  unlockedKey = key;
  lastTouchedAt = Date.now();
  return true;
}

export function lock(): void {
  // 显式覆写再丢弃：虽然 JS 管不了内存回收，但至少不留着引用
  unlockedKey?.fill(0);
  unlockedKey = null;
  lastTouchedAt = 0;
}

/**
 * 取当前密钥；未解锁或已超时就抛错。
 * 所有需要明文的操作都必须先过这一关，调用方不需要自己判断锁定状态。
 */
export function requireKey(): Buffer {
  expireIfIdle();
  if (!unlockedKey) {
    throw new Error('保险箱已锁定，请先解锁');
  }
  lastTouchedAt = Date.now();
  return unlockedKey;
}

export function encryptValue(plaintext: string): EncryptedValue {
  return encrypt(requireKey(), plaintext);
}

export function decryptValue(value: EncryptedValue): string {
  return decrypt(requireKey(), value);
}

function expireIfIdle(): void {
  if (unlockedKey && Date.now() - lastTouchedAt > LOCK_TIMEOUT_MS) {
    lock();
  }
}