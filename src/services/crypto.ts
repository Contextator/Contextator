import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (git / Notion tokens) are encrypted with AES-256-GCM under a key derived from
 * SECRET_KEY. Wire format: `v1.<iv>.<tag>.<ciphertext>` (base64url), so the scheme can change later.
 */

export class SecretKeyMissingError extends Error {
  constructor() {
    super('SECRET_KEY is not configured; set it (at least 32 characters) to store tokens for private sources');
    this.name = 'SecretKeyMissingError';
  }
}

export class SecretDecryptError extends Error {
  constructor() {
    super('Stored token cannot be decrypted (SECRET_KEY changed?). Re-enter the token for this source.');
    this.name = 'SecretDecryptError';
  }
}

const VERSION = 'v1';

function deriveKey(secretKey: string): Buffer {
  return createHash('sha256').update(secretKey, 'utf8').digest();
}

export function encryptSecret(plain: string, secretKey: string | undefined): string {
  if (!secretKey) throw new SecretKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(stored: string, secretKey: string | undefined): string {
  if (!secretKey) throw new SecretKeyMissingError();
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretDecryptError();
  try {
    const [, ivB64, tagB64, ctB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}

/** Random secret for webhooks (hex, 64 chars). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
