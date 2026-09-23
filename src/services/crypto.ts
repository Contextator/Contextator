import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (git / Notion / Confluence tokens, and the webhook secret a delivery is signed
 * with) are encrypted with AES-256-GCM under a key derived from `SECRET_KEY`.
 *
 * Wire format: `v2.<keyId>.<iv>.<tag>.<ciphertext>` (base64url except the key id, which is hex).
 *
 * **`v1` was a wire-format version and not a key identity**, and that is the whole reason this file
 * changed ([ADR-0075](../../.ssot/ADR.md#adr-0075)). A `v1.` value says how it was encrypted and says
 * nothing about *which key* did it, so a process holding two keys could only try both and a rotation
 * pass could not tell a row it had already converted from one it had not. `v2` carries a key check
 * value in the ciphertext itself, which makes both questions answerable without a decryption attempt.
 *
 * `v1.` values stay readable for ever — they are tried against every key in the ring — and are
 * rewritten as `v2.` the first time anything writes them, which for most installations is the first
 * run of `npm run rotate-secret`.
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

/** The format this file writes today. */
const VERSION = 'v2';
/** The format it still reads: four parts, no key identity. */
const LEGACY_VERSION = 'v1';

/**
 * The prefixes every envelope this file writes or reads begins with, derived from the two constants
 * above so that a third version cannot be introduced without this list growing with it.
 *
 * It is exported because one question about these values has to be asked in SQL rather than in
 * JavaScript: the backup manifest counts the rows a restore cannot read without the key, and it
 * counts them in the database. `encryptedRowFilter` in `encrypted-fields.ts` is the only caller, and
 * it is the only place allowed to turn these into a `LIKE`.
 */
export const ENVELOPE_PREFIXES: readonly string[] = [`${LEGACY_VERSION}.`, `${VERSION}.`];

/**
 * The label the key id is computed over — fixed and public, exactly like the backup manifest's
 * `FINGERPRINT_LABEL` (`scripts/backup-archive.ts`), and for the same reason: the secrecy is the
 * key's, and two values encrypted under one key *should* be recognisable as such, because that is how
 * the rotation pass knows what it has already done.
 *
 * It is a different label from the backup manifest's on purpose. The two identifiers live in
 * different places — one in a database column, one in an archive nobody encrypts — and giving them
 * the same value would let whoever holds an old backup recognise the current database's key from the
 * ciphertexts alone.
 */
export const KEY_ID_LABEL = 'contextator.secret-key-id.v1';

/**
 * A key check value for a `SECRET_KEY`: HMAC-SHA-256 keyed by the secret over a constant, truncated
 * to 32 bits and rendered as 8 hex characters.
 *
 * **Keyed by the secret rather than hashing it.** `sha256(key)` is exactly the encryption key this
 * file derives below, so storing it beside the ciphertext would be storing the key; and even a
 * different plain hash would be an offline verifier for candidate keys. An HMAC over a constant gives
 * nothing away.
 *
 * **32 bits is deliberate and sufficient.** This is a disambiguator between the two, at most three,
 * keys one installation has ever used — not a collision-resistant digest. A collision would cost one
 * failed decryption attempt and a fall back to trying the other key, which `decryptSecret` does
 * anyway, so the failure mode of the shortest useful id is "slightly slower", not "unreadable".
 */
export function secretKeyId(secretKey: string): string {
  return createHmac('sha256', secretKey).update(KEY_ID_LABEL).digest('hex').slice(0, 8);
}

/**
 * The keys this process will read with, and the one it writes with.
 *
 * `current` encrypts; both are tried when decrypting. `previous` is set only for the length of a
 * rotation — see `.ssot/OPERATIONS.md` §5.20 — and removing it again is the step that actually
 * retires the old key.
 */
export interface SecretKeyring {
  /** `SECRET_KEY`. Every write uses this one; `undefined` means the instance has no key at all. */
  current: string | undefined;
  /** `SECRET_KEY_PREVIOUS`, during a rotation. Reads fall back to it; nothing is ever written with it. */
  previous?: string | undefined;
}

/** The ring an instance's configuration describes. */
export function keyringOf(config: { SECRET_KEY?: string | undefined; SECRET_KEY_PREVIOUS?: string | undefined }): SecretKeyring {
  return { current: config.SECRET_KEY, previous: config.SECRET_KEY_PREVIOUS };
}

function deriveKey(secretKey: string): Buffer {
  return createHash('sha256').update(secretKey, 'utf8').digest();
}

export function encryptSecret(plain: string, keys: SecretKeyring): string {
  if (!keys.current) throw new SecretKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keys.current), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, secretKeyId(keys.current), iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

interface Envelope {
  /** The key id the value declares, or `null` for a `v1.` value that declares none. */
  keyId: string | null;
  ivB64: string;
  tagB64: string;
  ctB64: string;
}

function parseEnvelope(stored: string): Envelope | null {
  const parts = stored.split('.');
  if (parts.length === 5 && parts[0] === VERSION) return { keyId: parts[1], ivB64: parts[2], tagB64: parts[3], ctB64: parts[4] };
  if (parts.length === 4 && parts[0] === LEGACY_VERSION) return { keyId: null, ivB64: parts[1], tagB64: parts[2], ctB64: parts[3] };
  return null;
}

/** Whether a stored string is one of this file's envelopes at all, without trying to open it. */
export function isEncryptedSecret(stored: string): boolean {
  return parseEnvelope(stored) !== null;
}

/**
 * The key id a stored value declares: `null` for a `v1.` value (which declares none) and for anything
 * that is not an envelope. Never throws — this is a question about the string, not about the key.
 */
export function storedKeyId(stored: string): string | null {
  return parseEnvelope(stored)?.keyId ?? null;
}

/**
 * Whether this value would be rewritten by a rotation: anything not already sealed under `current`.
 *
 * A `v1.` value answers `true` even when `current` is the key that wrote it, because the point of the
 * rewrite is the identity the value is missing.
 */
export function needsReEncryption(stored: string, keys: SecretKeyring): boolean {
  if (!keys.current) return false;
  return storedKeyId(stored) !== secretKeyId(keys.current);
}

function open(envelope: Envelope, secretKey: string): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), Buffer.from(envelope.ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Opens a stored value with whichever key in the ring wrote it.
 *
 * The declared key id only *orders* the attempt, it does not gate it: a value whose id matches
 * `current` is tried against `current` first, and everything else in the ring is still tried after.
 * That ordering is what makes the common case one AES operation instead of two, and refusing to try
 * the other key would turn a 32-bit collision — or a hand-edited row — into an unreadable secret.
 */
export function decryptSecret(stored: string, keys: SecretKeyring): string {
  if (!keys.current && !keys.previous) throw new SecretKeyMissingError();
  const envelope = parseEnvelope(stored);
  if (!envelope) throw new SecretDecryptError();

  const ring = [keys.current, keys.previous].filter((k): k is string => Boolean(k));
  const ordered =
    envelope.keyId === null
      ? ring
      : [...ring.filter((k) => secretKeyId(k) === envelope.keyId), ...ring.filter((k) => secretKeyId(k) !== envelope.keyId)];
  for (const key of ordered) {
    const plain = open(envelope, key);
    if (plain !== null) return plain;
  }
  throw new SecretDecryptError();
}

/**
 * A webhook secret at rest — the one column in this product that has a legible past.
 *
 * `document_sources.webhook_secret` held its value in the clear until
 * [ADR-0075](../../.ssot/ADR.md#adr-0075), so every installation that upgrades has rows this file did
 * not write. They stay readable: a value that is not an envelope is its own plaintext, and the first
 * write — an operator regenerating it, Notion re-verifying, or `npm run rotate-secret` — seals it.
 *
 * **It is also the one secret an instance may hold without having a `SECRET_KEY` at all.** A git
 * source on a public repository stores no token, and ADR-0017's promise is that such an instance
 * never has to set a key; a webhook secret that *required* one would have quietly broken that. With
 * no key the value is written as it always was, and `rotate-secret` seals it on the day a key
 * appears.
 */
export function encryptWebhookSecret(plain: string, keys: SecretKeyring): string {
  return keys.current ? encryptSecret(plain, keys) : plain;
}

/** The counterpart read: an envelope is opened, anything else is already the secret. */
export function decryptWebhookSecret(stored: string, keys: SecretKeyring): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored, keys) : stored;
}

/** Random secret for webhooks (hex, 64 chars). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
