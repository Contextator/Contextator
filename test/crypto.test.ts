import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  decryptWebhookSecret,
  encryptSecret,
  encryptWebhookSecret,
  isEncryptedSecret,
  keyringOf,
  needsReEncryption,
  randomSecret,
  SecretDecryptError,
  SecretKeyMissingError,
  secretKeyId,
  storedKeyId,
} from '../src/services/crypto.js';
import type { IndexerDeps } from '../src/services/indexer.js';
import type { SchedulerDeps } from '../src/services/scheduler.js';
import type { DriverContext } from '../src/services/sources/driver.js';

const KEY = 'a'.repeat(40);
const OLD_KEY = 'b'.repeat(40);
const ring = { current: KEY };
const rotating = { current: KEY, previous: OLD_KEY };

/**
 * A value in the format this product wrote before ADR-0075: `v1.<iv>.<tag>.<ciphertext>`, with no key
 * identity in it.
 *
 * Written out by hand rather than taken from git history on purpose. Every installation that upgrades
 * has rows in this shape, and "they still open" is a promise about bytes that already exist — a test
 * that produced them with the current encoder would only be testing the current encoder.
 */
function v1(plain: string, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secretKey, 'utf8').digest(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

describe('secrets at rest', () => {
  it('round-trips and never stores the plaintext', () => {
    const stored = encryptSecret('ghp_token-123', ring);
    expect(stored.startsWith('v2.')).toBe(true);
    expect(stored).not.toContain('ghp_token');
    expect(decryptSecret(stored, ring)).toBe('ghp_token-123');
  });

  it('produces different ciphertexts for the same plaintext (random iv)', () => {
    expect(encryptSecret('x', ring)).not.toBe(encryptSecret('x', ring));
  });

  it('fails cleanly with a different key or a tampered payload', () => {
    const stored = encryptSecret('secret', ring);
    expect(() => decryptSecret(stored, { current: OLD_KEY })).toThrow(SecretDecryptError);
    expect(() => decryptSecret(stored.slice(0, -2) + 'zz', ring)).toThrow(SecretDecryptError);
    expect(() => decryptSecret('garbage', ring)).toThrow(SecretDecryptError);
  });

  it('requires SECRET_KEY', () => {
    expect(() => encryptSecret('x', { current: undefined })).toThrow(SecretKeyMissingError);
    expect(() => decryptSecret('v1.a.b.c', { current: undefined })).toThrow(SecretKeyMissingError);
  });

  it('generates hex webhook secrets', () => {
    expect(randomSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('key identity', () => {
  it('is stable for a key, different between keys, and not the key', () => {
    expect(secretKeyId(KEY)).toBe(secretKeyId(KEY));
    expect(secretKeyId(KEY)).not.toBe(secretKeyId(OLD_KEY));
    expect(secretKeyId(KEY)).toMatch(/^[0-9a-f]{8}$/);
    // The derived encryption key is sha256(SECRET_KEY); an id equal to a prefix of it would be the key.
    expect(createHash('sha256').update(KEY, 'utf8').digest('hex')).not.toContain(secretKeyId(KEY));
  });

  it('travels in the ciphertext, so a value says which key wrote it', () => {
    expect(storedKeyId(encryptSecret('x', ring))).toBe(secretKeyId(KEY));
    expect(storedKeyId(encryptSecret('x', { current: OLD_KEY }))).toBe(secretKeyId(OLD_KEY));
  });

  it('is absent from a v1 value and from anything that is not an envelope', () => {
    expect(storedKeyId(v1('x', KEY))).toBeNull();
    expect(storedKeyId('plain-text')).toBeNull();
  });

  it('recognises envelopes without opening them', () => {
    expect(isEncryptedSecret(encryptSecret('x', ring))).toBe(true);
    expect(isEncryptedSecret(v1('x', KEY))).toBe(true);
    expect(isEncryptedSecret('c0ffee'.repeat(8))).toBe(false);
    expect(isEncryptedSecret('v2.only.three.parts')).toBe(false);
  });
});

describe('reading during a rotation', () => {
  it('opens a value the retired key wrote', () => {
    const stored = encryptSecret('notion-token', { current: OLD_KEY });
    expect(decryptSecret(stored, rotating)).toBe('notion-token');
  });

  it('opens a value the new key wrote', () => {
    expect(decryptSecret(encryptSecret('new', ring), rotating)).toBe('new');
  });

  it('writes only with the current key, whichever key the ring also holds', () => {
    expect(storedKeyId(encryptSecret('x', rotating))).toBe(secretKeyId(KEY));
  });

  it('opens a pre-rotation v1 value under either key in the ring', () => {
    expect(decryptSecret(v1('old-token', OLD_KEY), rotating)).toBe('old-token');
    expect(decryptSecret(v1('older-token', KEY), rotating)).toBe('older-token');
  });

  it('still refuses a value no key in the ring wrote', () => {
    const stored = encryptSecret('x', { current: 'c'.repeat(40) });
    expect(() => decryptSecret(stored, rotating)).toThrow(SecretDecryptError);
  });

  it('reads with the previous key alone, which is what a misconfigured half-rotation looks like', () => {
    const stored = encryptSecret('x', { current: OLD_KEY });
    expect(decryptSecret(stored, { current: undefined, previous: OLD_KEY })).toBe('x');
  });
});

describe('what a rotation still owes', () => {
  it('is nothing for a value already under the current key', () => {
    expect(needsReEncryption(encryptSecret('x', ring), ring)).toBe(false);
  });

  it('is a rewrite for a value under the retired key', () => {
    expect(needsReEncryption(encryptSecret('x', { current: OLD_KEY }), rotating)).toBe(true);
  });

  it('is a rewrite for a v1 value even when the current key is the one that wrote it', () => {
    expect(needsReEncryption(v1('x', KEY), ring)).toBe(true);
  });

  it('is a rewrite for legacy plaintext', () => {
    expect(needsReEncryption('a-plain-webhook-secret', ring)).toBe(true);
  });

  it('is nothing at all when the instance has no key', () => {
    expect(needsReEncryption('anything', { current: undefined })).toBe(false);
  });
});

describe('webhook secrets, which have a legible past', () => {
  it('are encrypted when the instance has a key', () => {
    const stored = encryptWebhookSecret('wh-secret', ring);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptWebhookSecret(stored, ring)).toBe('wh-secret');
  });

  it('are stored as they always were when the instance has none — ADR-0017 stays true', () => {
    const stored = encryptWebhookSecret('wh-secret', { current: undefined });
    expect(stored).toBe('wh-secret');
    expect(decryptWebhookSecret(stored, { current: undefined })).toBe('wh-secret');
  });

  it('read back a value written before ADR-0075 as its own plaintext', () => {
    expect(decryptWebhookSecret('64-hex-ish-value', ring)).toBe('64-hex-ish-value');
  });
});

describe('keyringOf', () => {
  it('carries both configured keys', () => {
    expect(keyringOf({ SECRET_KEY: KEY, SECRET_KEY_PREVIOUS: OLD_KEY })).toEqual({ current: KEY, previous: OLD_KEY });
    expect(keyringOf({})).toEqual({ current: undefined, previous: undefined });
  });
});

/**
 * A driver is built from whatever config its caller holds: `IndexerDeps` for a sync, `SchedulerDeps`
 * for a probe. `DriverContext` asks for the whole ring, and the field being optional is exactly why the
 * compiler would stay quiet if either caller's `Pick` left `SECRET_KEY_PREVIOUS` out — the first narrowed
 * literal handed to one of them would drop the retired key in the rotation window, and every source
 * still under it would read as `unreadable` ([ADR-0075](../../.ssot/ADR.md#adr-0075)).
 *
 * Two layers, because either alone would pass a broken tree: the type-level assertions fail
 * `npm run typecheck` when a caller's `Pick` is narrower than `DriverContext`'s, and the runtime ones
 * show that a config typed as each caller's own carries the key a rotation still needs.
 */
describe('the config a driver is built from', () => {
  type Missing<Caller> = Exclude<keyof DriverContext['config'], keyof Caller>;
  // `[never] extends [Missing<…>]` is only true when nothing is missing; the tuple stops distribution.
  const indexerCarriesTheDriverConfig: [Missing<IndexerDeps['config']>] extends [never] ? true : false = true;
  const schedulerCarriesTheDriverConfig: [Missing<SchedulerDeps['config']>] extends [never] ? true : false = true;

  it('is never narrower in the indexer or the scheduler than a driver needs', () => {
    expect(indexerCarriesTheDriverConfig).toBe(true);
    expect(schedulerCarriesTheDriverConfig).toBe(true);
  });

  it('opens a value the retired key wrote, from a config typed as the indexer holds it', () => {
    const config: Pick<IndexerDeps['config'], 'SECRET_KEY' | 'SECRET_KEY_PREVIOUS'> = { SECRET_KEY: KEY, SECRET_KEY_PREVIOUS: OLD_KEY };
    expect(decryptSecret(encryptSecret('git-token', { current: OLD_KEY }), keyringOf(config))).toBe('git-token');
  });

  it('opens a value the retired key wrote, from a config typed as the scheduler holds it', () => {
    const config: Pick<SchedulerDeps['config'], 'SECRET_KEY' | 'SECRET_KEY_PREVIOUS'> = { SECRET_KEY: KEY, SECRET_KEY_PREVIOUS: OLD_KEY };
    expect(decryptSecret(encryptSecret('confluence-token', { current: OLD_KEY }), keyringOf(config))).toBe('confluence-token');
  });
});
