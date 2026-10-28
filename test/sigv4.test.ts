import { describe, expect, it } from 'vitest';
import { signRequest as backupSignRequest } from '../scripts/backup-s3.js';
import { canonicalQuery, encodeComponent, encodePath, sha256Hex, signRequest } from '../src/services/s3/sigv4.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sigv4', () => {
  it('reproduces the signature AWS publishes for a GET Object with a Range header', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
    const headers = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: [],
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('reproduces the signature AWS publishes for a bucket listing with a query', () => {
    // Same page, "Example: GET Bucket (List Objects)".
    const headers = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/',
      query: [
        ['max-keys', '2'],
        ['prefix', 'J'],
      ],
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toContain('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('adds the session token header to what is signed only when one is given', () => {
    const base = {
      method: 'GET',
      host: 'h',
      path: '/',
      query: [] as Array<[string, string]>,
      payloadHash: EMPTY_SHA256,
      region: 'r',
      accessKeyId: 'a',
      secretAccessKey: 's',
      date: new Date('2026-01-02T03:04:05Z'),
    };
    expect(signRequest(base)['x-amz-security-token']).toBeUndefined();
    const withToken = signRequest({ ...base, sessionToken: 'tok' });
    expect(withToken['x-amz-security-token']).toBe('tok');
    expect(withToken.authorization).toContain('x-amz-security-token');
  });

  it('encodes the characters SigV4 insists on and encodeURIComponent leaves alone', () => {
    expect(encodeComponent("a b!'()*~")).toBe('a%20b%21%27%28%29%2A~');
    expect(encodePath('dir one/file (1).md')).toBe('dir%20one/file%20%281%29.md');
  });

  it('sorts the canonical query by encoded name, then value', () => {
    expect(
      canonicalQuery([
        ['b', '2'],
        ['a', '2'],
        ['a', '1'],
        ['c d', 'e/f'],
      ]),
    ).toBe('a=1&a=2&b=2&c%20d=e%2Ff');
  });

  it('hashes strings and bytes alike', () => {
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
  });

  it('is the signer the backup command exports', () => {
    expect(backupSignRequest).toBe(signRequest);
  });
});
