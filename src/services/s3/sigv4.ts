import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, by hand, over `node:crypto` ([ADR-0120](../../../.ssot/ADR.md#adr-0120),
 * [ADR-0126](../../../.ssot/ADR.md#adr-0126)).
 *
 * Moved out of `scripts/backup-s3.ts` so that the backup command and the `s3` source driver sign with
 * one implementation. The backup command re-exports {@link signRequest}; its test pins the signature
 * against fixed vectors and must pass unchanged.
 */

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 unreserved set only; `encodeURIComponent` leaves `!'()*` alone and SigV4 does not. */
export function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodePath(value: string): string {
  return value.split('/').map(encodeComponent).join('/');
}

export function canonicalQuery(query: Array<[string, string]>): string {
  return query
    .map(([k, v]) => [encodeComponent(k), encodeComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export interface SignInput {
  method: string;
  /** `URL.host`: hostname plus the port when it is not the scheme's default. */
  host: string;
  /** Already percent-encoded, starting with `/`. */
  path: string;
  query: Array<[string, string]>;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`, which are added here. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
  service?: string;
}

/** Returns every header to send except `host` (which `fetch` derives from the URL it is given). */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3';
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const signedNames = ['host', ...Object.keys(headers)].sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${name === 'host' ? input.host : headers[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [input.method, input.path, canonicalQuery(input.query), canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
