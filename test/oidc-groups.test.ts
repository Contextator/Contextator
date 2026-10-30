import { describe, expect, it } from 'vitest';

import { EnvSchema } from '../src/config.js';
import { MAX_GROUP_CLAIM_ENTRIES, MAX_GROUP_NAME_CHARS, readGroupsClaim } from '../src/services/auth/oidc-groups.js';

/** The pure halves of OIDC group mapping (ADR-0134): the setting, and how the ID token's claim is read. */

const ENV = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ALLOWED_DOC_ROOTS: '/docs' };
const OIDC = { OIDC_ISSUER_URL: 'https://idp.example.test', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret' };
const parse = (overrides: Record<string, string> = {}) => EnvSchema.safeParse({ ...ENV, ...overrides });

describe('OIDC_GROUPS_CLAIM', () => {
  it('is off unless it is set', () => {
    const parsed = parse(OIDC);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.OIDC_GROUPS_CLAIM).toBeUndefined();
  });

  it('is accepted with the provider it reads from', () => {
    const parsed = parse({ ...OIDC, OIDC_GROUPS_CLAIM: 'https://example.test/claims/groups' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.OIDC_GROUPS_CLAIM).toBe('https://example.test/claims/groups');
  });

  it('refuses to start without OIDC_ISSUER_URL', () => {
    const parsed = parse({ OIDC_GROUPS_CLAIM: 'groups' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'OIDC_GROUPS_CLAIM')).toBe(true);
  });

  it.each(['has space', 'tab\t', 'new\nline', 'a'.repeat(129), 'quo"te', 'semi;colon'])(
    'refuses a name outside the claim character set (%j)',
    (name) => {
      expect(parse({ ...OIDC, OIDC_GROUPS_CLAIM: name }).success).toBe(false);
    },
  );
});

describe('readGroupsClaim', () => {
  const read = (claims: Record<string, unknown>) => readGroupsClaim(claims, 'groups');

  it('reads a list of strings as a sorted set without duplicates', () => {
    expect(read({ groups: ['b', 'a', 'b'] })).toEqual({ ok: true, groups: ['a', 'b'] });
  });

  it('matches names exactly: case and surrounding whitespace are part of the name', () => {
    expect(read({ groups: ['Admins', 'admins', ' admins'] })).toEqual({ ok: true, groups: [' admins', 'Admins', 'admins'] });
  });

  it.each([
    ['an absent claim', {}],
    ['null', { groups: null }],
    ['an empty list', { groups: [] }],
    ['an empty object', { groups: {} }],
  ])('reads %s as no group', (_label, claims) => {
    expect(read(claims)).toEqual({ ok: true, groups: [] });
  });

  it('drops an empty name rather than refusing the claim', () => {
    expect(read({ groups: ['', 'a'] })).toEqual({ ok: true, groups: ['a'] });
  });

  it('reads the configured claim name, not a fixed one', () => {
    expect(readGroupsClaim({ roles: ['x'], groups: ['y'] }, 'roles')).toEqual({ ok: true, groups: ['x'] });
    expect(readGroupsClaim({ 'https://example.test/groups': ['z'] }, 'https://example.test/groups')).toEqual({ ok: true, groups: ['z'] });
  });

  it('refuses the Entra overage marker, with or without a claim beside it', () => {
    expect(read({ _claim_names: { groups: 'src1' } })).toEqual({ ok: false, reason: 'overage' });
    expect(read({ groups: ['a'], _claim_names: { groups: 'src1' } })).toEqual({ ok: false, reason: 'overage' });
  });

  it('refuses a marker under the configured claim name too', () => {
    expect(readGroupsClaim({ _claim_names: { roles: 'src1' } }, 'roles')).toEqual({ ok: false, reason: 'overage' });
  });

  it('does not take an unrelated _claim_names entry for an overage', () => {
    expect(read({ _claim_names: { other: 'src1' }, groups: ['a'] })).toEqual({ ok: true, groups: ['a'] });
  });

  it.each([
    ['a string', { groups: 'admins' }],
    ['a number', { groups: 3 }],
    ['a boolean', { groups: true }],
    ['a non-empty object', { groups: { admins: true } }],
    ['a list with a non-string', { groups: ['a', 2] }],
    ['a list with a nested list', { groups: [['a']] }],
  ])('refuses %s: it is not a list of strings', (_label, claims) => {
    expect(read(claims)).toEqual({ ok: false, reason: 'not_a_list' });
  });

  it('accepts exactly the entry limit and refuses one more', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`);
    expect(read({ groups: entries(MAX_GROUP_CLAIM_ENTRIES) })).toMatchObject({ ok: true });
    expect(read({ groups: entries(MAX_GROUP_CLAIM_ENTRIES + 1) })).toEqual({ ok: false, reason: 'too_many' });
  });

  it('counts entries before it removes duplicates', () => {
    expect(read({ groups: Array.from({ length: MAX_GROUP_CLAIM_ENTRIES + 1 }, () => 'same') })).toEqual({ ok: false, reason: 'too_many' });
  });

  it('accepts a name of exactly the length limit and refuses a longer one', () => {
    expect(read({ groups: ['x'.repeat(MAX_GROUP_NAME_CHARS)] })).toMatchObject({ ok: true });
    expect(read({ groups: ['x'.repeat(MAX_GROUP_NAME_CHARS + 1)] })).toEqual({ ok: false, reason: 'entry_too_long' });
  });

  it('does not read a claim off the prototype', () => {
    expect(readGroupsClaim(Object.create({ groups: ['inherited'] }) as Record<string, unknown>, 'groups')).toEqual({ ok: true, groups: [] });
  });
});
