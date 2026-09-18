import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, clearSessionCookie, cookieSecure, setSessionCookie } from '../src/auth/cookies.js';
import { hashSessionToken, newSessionToken } from '../src/services/auth/sessions.js';
import { SetupGate, generateSetupCode, setupCodeMatches } from '../src/services/auth/setup.js';
import { lockDurationMs, lockRemainingSec, USERNAME_RE, normalizeUsername } from '../src/services/auth/users.js';
import type { Config } from '../src/config.js';
import type { UserRow } from '../src/db/schema.js';

const config = (over: Partial<Config> = {}) =>
  ({ AUTH_COOKIE_SECURE: 'auto', AUTH_SESSION_TTL_DAYS: 30, PUBLIC_BASE_URL: undefined, ...over }) as Config;

/** Drives the real cookie helpers through a real reply, so the serialization is Fastify's own. */
async function cookieHeader(kind: 'set' | 'clear', over: Partial<Config>, protocol = 'http'): Promise<string> {
  const app = Fastify();
  await app.register(cookie);
  app.get('/', async (req, reply) => {
    Object.defineProperty(req, 'protocol', { value: protocol, configurable: true });
    if (kind === 'set') setSessionCookie(reply, req, config(over), 'ctxs_abc');
    else clearSessionCookie(reply, req, config(over));
    return reply.code(204).send();
  });
  const res = await app.inject({ method: 'GET', url: '/' });
  await app.close();
  return String(res.headers['set-cookie']);
}

describe('session tokens', () => {
  it('are opaque, greppable and long enough to be unguessable', () => {
    const token = newSessionToken();
    expect(token).toMatch(/^ctxs_[0-9a-f]{64}$/); // 32 random bytes
    expect(new Set(Array.from({ length: 200 }, newSessionToken)).size).toBe(200);
  });

  it('are stored only as a hash, deterministically', () => {
    const token = newSessionToken();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
  });
});

describe('the session cookie', () => {
  it('is HttpOnly, Lax and rooted at /', async () => {
    const header = await cookieHeader('set', {});
    expect(header).toContain(`${SESSION_COOKIE}=ctxs_abc`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=2592000'); // 30 days
  });

  it('adds Secure over HTTPS and never when it is switched off', async () => {
    expect(await cookieHeader('set', {}, 'https')).toContain('Secure');
    expect(await cookieHeader('set', {}, 'http')).not.toContain('Secure');
    expect(await cookieHeader('set', { AUTH_COOKIE_SECURE: '1' }, 'http')).toContain('Secure');
    // A plain-HTTP LAN install must be able to say "no", or the browser drops every cookie we set.
    expect(await cookieHeader('set', { AUTH_COOKIE_SECURE: '0' }, 'https')).not.toContain('Secure');
  });

  it('follows PUBLIC_BASE_URL when the request arrives from a terminating proxy as http', () => {
    const req = { protocol: 'http' } as never;
    expect(cookieSecure(config({ PUBLIC_BASE_URL: 'https://docs.example.com' }), req)).toBe(true);
    expect(cookieSecure(config(), req)).toBe(false);
  });

  it('is cleared by expiring it, not by dropping the header', async () => {
    const header = await cookieHeader('clear', {});
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

describe('the first-run setup code', () => {
  it('avoids characters that are misread off a terminal', () => {
    for (let i = 0; i < 200; i++)
      expect(generateSetupCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}$/);
  });

  it('forgives the dashes and the case, because it is typed by hand', () => {
    expect(setupCodeMatches('abcd-efgh-jklm', 'ABCD-EFGH-JKLM')).toBe(true);
    expect(setupCodeMatches('ABCDEFGHJKLM', 'ABCD-EFGH-JKLM')).toBe(true);
    expect(setupCodeMatches('ABCD EFGH JKLM', 'ABCD-EFGH-JKLM')).toBe(true);
    expect(setupCodeMatches('ABCD-EFGH-JKLN', 'ABCD-EFGH-JKLM')).toBe(false);
    expect(setupCodeMatches('', 'ABCD-EFGH-JKLM')).toBe(false); // a length mismatch must not throw
  });

  it('ignores punctuation in an operator-chosen code, which .env.example warns about', () => {
    expect(setupCodeMatches('EKIP KURULUM 2026', 'ekip-kurulum-2026')).toBe(true);
    expect(setupCodeMatches('ekip_kurulum_2026', 'ekip-kurulum-2026')).toBe(true);
    expect(setupCodeMatches('ekipkurulum2027', 'ekip-kurulum-2026')).toBe(false);
  });

  it('is armed only while no account exists, and never comes back', () => {
    const gate = new SetupGate();
    gate.arm(0);
    expect(gate.needsSetup).toBe(true);
    expect(gate.pendingCode).not.toBeNull();
    expect(gate.verify(gate.pendingCode!)).toBe(true);

    gate.complete();
    expect(gate.needsSetup).toBe(false);
    expect(gate.pendingCode).toBeNull();
    expect(gate.verify('ABCD-EFGH-JKLM')).toBe(false);
  });

  it('stays closed on a restart that finds accounts', () => {
    const gate = new SetupGate();
    gate.arm(3);
    expect(gate.needsSetup).toBe(false);
    expect(gate.pendingCode).toBeNull();
  });

  it('can be pinned in .env, and then is never echoed back into the log', () => {
    const gate = new SetupGate();
    gate.arm(0, 'PINNED-CODE-1234');
    expect(gate.pendingCode).toBe('PINNED-CODE-1234');
    expect(gate.verify('pinned-code-1234')).toBe(true);
    expect(gate.codeIsPinned).toBe(true);
    // The operator already has it; repeating their secret into the log would outlive the setup window.
    const banner = gate.banner('http://localhost:3444');
    expect(banner).not.toContain('PINNED-CODE-1234');
    expect(banner).toContain('SETUP_CODE');
  });

  it('draws a box whose borders line up, because it is meant to be read', () => {
    const gate = new SetupGate();
    gate.arm(0);
    const lines = gate.banner('http://localhost:3444').split('\n').filter(Boolean);
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines.at(-1)!.startsWith('└')).toBe(true);
    expect(lines.some((l) => l.includes(gate.pendingCode!))).toBe(true);
  });
});

describe('sign-in lockout', () => {
  const user = (over: Partial<UserRow>) => ({ failedLoginCount: 0, lockedUntil: null, ...over }) as UserRow;

  it('does nothing until the threshold, then backs off by doubling up to an hour', () => {
    expect(lockDurationMs(9, 10, 15)).toBe(0);
    expect(lockDurationMs(10, 10, 15)).toBe(15 * 60_000);
    expect(lockDurationMs(11, 10, 15)).toBe(30 * 60_000);
    expect(lockDurationMs(12, 10, 15)).toBe(60 * 60_000);
    expect(lockDurationMs(40, 10, 15)).toBe(60 * 60_000); // capped
  });

  it('reports the remaining lock in whole seconds and forgets a lock that has passed', () => {
    expect(lockRemainingSec(user({}))).toBe(0);
    expect(lockRemainingSec(user({ lockedUntil: new Date(2_000) }), 1_000)).toBe(1);
    expect(lockRemainingSec(user({ lockedUntil: new Date(1_000) }), 2_000)).toBe(0);
  });
});

describe('usernames', () => {
  it('are lowercased and trimmed before anything looks them up', () => {
    expect(normalizeUsername('  Alice  ')).toBe('alice');
  });

  it('accept the boring shapes and refuse the rest', () => {
    for (const ok of ['alice', 'a1', 'first.last', 'ops-team', 'a_b']) expect(USERNAME_RE.test(ok)).toBe(true);
    for (const bad of ['a', 'Alice', '-alice', '.alice', 'alice!', 'ali ce', 'a'.repeat(64), '']) expect(USERNAME_RE.test(bad)).toBe(false);
  });
});
