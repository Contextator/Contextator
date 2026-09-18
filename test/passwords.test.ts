import { describe, expect, it } from 'vitest';
import {
  PasswordPolicyError,
  assertPasswordAcceptable,
  generateTempPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/services/passwords.js';

describe('password hashing', () => {
  it('round-trips and never stores the plaintext', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('v1.32768.8.1.')).toBe(true);
    expect(stored).not.toContain('horse');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('salts every hash separately', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('treats the two Unicode spellings of a character as the same password', async () => {
    const composed = 'parolamé'; // é as one code point
    const decomposed = 'parolamé'; // e + combining acute
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it('answers false instead of throwing on a hash it cannot read', async () => {
    for (const bad of ['', 'garbage', 'v2.32768.8.1.aaaa.bbbb', 'v1.32768.8.1.aaaa', 'v1.x.8.1.aaaa.bbbb', 'v1.32768.8.1..']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('refuses to spend unbounded memory on parameters a stored row claims', async () => {
    // A row that asked for N=2^30 would allocate gigabytes before failing; reject it as unreadable.
    expect(await verifyPassword('x', `v1.${2 ** 30}.8.1.YWFhYQ.YmJiYg`)).toBe(false);
  });

  it('flags hashes made with weaker parameters for a silent upgrade', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
    expect(needsRehash('v1.16384.8.1.YWFhYQ.YmJiYg')).toBe(true);
    expect(needsRehash('nonsense')).toBe(true);
  });
});

describe('password policy', () => {
  const policy = { minLength: 12 };

  it('accepts anything long enough, with no composition rules', () => {
    expect(() => assertPasswordAcceptable('aaaaaaaaaaaa', policy)).not.toThrow();
  });

  it('rejects short, oversized, username-shaped and unchanged passwords', () => {
    expect(() => assertPasswordAcceptable('short', policy)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('x'.repeat(129), policy)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('Alice-Smith', { minLength: 8, username: 'alice-smith' })).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('samepassword', { minLength: 8, current: 'samepassword' })).toThrow(PasswordPolicyError);
  });
});

describe('generateTempPassword', () => {
  it('avoids characters that are read back wrong', () => {
    const password = generateTempPassword(200);
    expect(password).toHaveLength(200);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTempPassword()));
    expect(seen.size).toBe(500);
  });
});
