import { randomBytes, scrypt as scryptAsync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for local accounts.
 *
 * Uses Node's built-in scrypt (no native modules, no new dependency). The
 * recorded string follows the PHC convention: `scrypt$N$r$p$salt$hash`.
 *
 * Never log or return `encoded`; only the boolean result of
 * {@link verifyPassword} leaves this module.
 */

/** scrypt cost parameters: N=2^15, r=8, p=1 — roughly 40 ms on commodity hardware. */
const SCRYPT_N = 16_384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,60}$/;

/** Rejects weak passwords before they are ever hashed. */
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`密码长度必须在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符之间。`);
  }
  if (/^\s|\s$/.test(password)) throw new Error('密码首尾不能包含空白字符。');
}

export function validateUsername(username: unknown): asserts username is string {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new Error('用户名只能包含字母、数字、点、下划线和连字符，长度为 3 到 60 个字符。');
  }
}

const scrypt = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scryptAsync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [ , n, r, p, salt, hash ] = parts;
  const saltBuffer = Buffer.from(salt, 'hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  if (!saltBuffer.length || hashBuffer.length !== KEY_LENGTH) return false;
  try {
    const candidate = await scrypt(password, saltBuffer);
    return candidate.length === hashBuffer.length && timingSafeEqual(candidate, hashBuffer);
  } catch {
    return false;
  }
}
