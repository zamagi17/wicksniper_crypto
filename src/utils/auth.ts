import crypto from 'crypto';

/**
 * Hash password menggunakan algoritma scrypt bawaan Node.js crypto.
 * Format hash: salt:key (zero external dependencies).
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifikasi kecocokan password terhadap hash scrypt dengan timing-safe comparison.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash) return false;
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;
    const [salt, key] = parts;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    if (keyBuffer.length !== derivedKey.length) return false;
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}
