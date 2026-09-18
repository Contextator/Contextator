import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Passwords at rest are scrypt hashes from node:crypto — no native addon, nothing new in the
 * dependency tree, and the same `v1.` versioned wire format as services/crypto.ts:
 *
 *   v1.<N>.<r>.<p>.<salt base64url>.<hash base64url>
 *
 * The parameters travel with the hash, so N can be raised later and `needsRehash` will pick the
 * old ones up on the owner's next successful sign-in.
 */

const scrypt = promisify(scryptCb) as (password: string | Buffer, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const VERSION = 'v1';
const N = 32768; // 2^15 — roughly 32 MB and ~50-100 ms per hash
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Node's default maxmem is 32 MB, which is exactly too little for N=2^15; be explicit. */
const maxmemFor = (n: number, r: number) => 256 * n * r;

interface Params {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** Part of the v1 definition: the same characters must hash the same however they were typed. */
const normalize = (plain: string): string => plain.normalize('NFKC');

async function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scrypt(normalize(plain), salt, KEY_LEN, { N: n, r, p, maxmem: maxmemFor(n, r) });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await derive(plain, salt, N, R, P);
  return [VERSION, N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('.');
}

function parse(stored: string): Params | null {
  const parts = stored.split('.');
  if (parts.length !== 6 || parts[0] !== VERSION) return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) return null;
  // Refuse to spend arbitrary memory on a hash somebody else's row claims to need.
  if (n > 1 << 20 || r > 32 || p > 16) return null;
  try {
    return { n, r, p, salt: Buffer.from(parts[4], 'base64url'), hash: Buffer.from(parts[5], 'base64url') };
  } catch {
    return null;
  }
}

/** Never throws: a malformed or foreign hash simply does not match. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const params = parse(stored);
  if (!params || params.hash.length === 0) return false;
  try {
    const candidate = await derive(plain, params.salt, params.n, params.r, params.p);
    return candidate.length === params.hash.length && timingSafeEqual(candidate, params.hash);
  } catch {
    return false;
  }
}

/** True when the stored hash was made with weaker parameters than the current default. */
export function needsRehash(stored: string): boolean {
  const params = parse(stored);
  return !params || params.n < N || params.r < R || params.p < P;
}

/**
 * A hash nobody owns. Verifying against it when the username does not exist keeps the response
 * time of "no such user" and "wrong password" the same, so the login form cannot be used to
 * enumerate accounts. Built once, lazily, off the request path after the first login.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

export async function burnPasswordTime(plain: string): Promise<void> {
  await verifyPassword(plain, await dummyPasswordHash());
}

// ---------- policy ----------

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export interface PasswordPolicy {
  minLength: number;
  username?: string;
  current?: string;
}

/** Length and two obvious footguns; no composition rules, no blocklist. */
export function assertPasswordAcceptable(plain: string, policy: PasswordPolicy): void {
  const value = normalize(plain);
  if (value.length < policy.minLength) throw new PasswordPolicyError(`Password must be at least ${policy.minLength} characters`);
  if (value.length > 128) throw new PasswordPolicyError('Password must be at most 128 characters');
  if (policy.username && value.toLowerCase() === policy.username.toLowerCase()) throw new PasswordPolicyError('Password must not be the username');
  if (policy.current && value === normalize(policy.current)) throw new PasswordPolicyError('The new password must differ from the current one');
}

/**
 * Temporary password an administrator reads out or pastes into a message. No characters that are
 * confused with one another in a terminal or a handwritten note.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function generateTempPassword(length = 20): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
