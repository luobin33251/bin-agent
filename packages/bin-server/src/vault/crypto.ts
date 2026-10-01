import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * 保险箱的加密原语。
 *
 * 只做三件事：从主密码派生密钥、AES-256-GCM 加密、解密。
 * 不碰数据库、不碰业务——这样它能在任何地方单独测。
 */

/**
 * scrypt 参数。
 *
 * N=2^15 / r=8 在普通笔记本上约 100ms：足够拖慢暴力破解，又不至于让解锁卡顿。
 * maxmem 必须显式放大——scrypt 需要约 128*N*r ≈ 33MB，超过 Node 默认的 32MB 上限会直接抛错。
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM 推荐 12 字节
const SALT_LEN = 16;

/** 校验块的明文。解锁时能把它解出来，就说明主密码是对的 */
const CHECK_PLAINTEXT = 'bin-agent-vault-v1';

export interface EncryptedValue {
  cipher: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function createSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

/**
 * 从主密码派生密钥。
 *
 * 先做 NFKC 归一化：中文输入法下的全角字符、以及 macOS/Windows 上看似一样的
 * 组合字符，字节序列可能不同。不归一化就会出现「密码明明打对了却解不开」。
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function encrypt(key: Buffer, plaintext: string): EncryptedValue {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { cipher: encrypted, iv, authTag: cipher.getAuthTag() };
}

/**
 * 解密。密码不对时 GCM 的认证标签校验会失败并抛错——
 * 这正是「不需要单独存密码哈希」的原因：能解开校验块本身就是验证。
 */
export function decrypt(key: Buffer, value: EncryptedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', key, value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.cipher), decipher.final()]).toString('utf8');
}

export function makeCheck(key: Buffer): EncryptedValue {
  return encrypt(key, CHECK_PLAINTEXT);
}

export function verifyKey(key: Buffer, check: EncryptedValue): boolean {
  try {
    return decrypt(key, check) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/** 三件套打包成一个字符串存进 app_meta，避免三个键各写一遍 */
export function packEncrypted(value: EncryptedValue): string {
  return Buffer.concat([value.iv, value.authTag, value.cipher]).toString('base64');
}

export function unpackEncrypted(packed: string): EncryptedValue {
  const raw = Buffer.from(packed, 'base64');
  return {
    iv: raw.subarray(0, IV_LEN),
    authTag: raw.subarray(IV_LEN, IV_LEN + 16),
    cipher: raw.subarray(IV_LEN + 16),
  };
}

export const GCM_TAG_LEN = 16;