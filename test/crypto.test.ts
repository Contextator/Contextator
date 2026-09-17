import { describe, expect, it } from 'vitest';
import { SecretDecryptError, SecretKeyMissingError, decryptSecret, encryptSecret, randomSecret } from '../src/services/crypto.js';

const KEY = 'a'.repeat(40);

describe('secrets at rest', () => {
  it('round-trips and never stores the plaintext', () => {
    const stored = encryptSecret('ghp_token-123', KEY);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('ghp_token');
    expect(decryptSecret(stored, KEY)).toBe('ghp_token-123');
  });

  it('produces different ciphertexts for the same plaintext (random iv)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('fails cleanly with a different key or a tampered payload', () => {
    const stored = encryptSecret('secret', KEY);
    expect(() => decryptSecret(stored, 'b'.repeat(40))).toThrow(SecretDecryptError);
    expect(() => decryptSecret(stored.slice(0, -2) + 'zz', KEY)).toThrow(SecretDecryptError);
    expect(() => decryptSecret('garbage', KEY)).toThrow(SecretDecryptError);
  });

  it('requires SECRET_KEY', () => {
    expect(() => encryptSecret('x', undefined)).toThrow(SecretKeyMissingError);
    expect(() => decryptSecret('v1.a.b.c', undefined)).toThrow(SecretKeyMissingError);
  });

  it('generates hex webhook secrets', () => {
    expect(randomSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});
