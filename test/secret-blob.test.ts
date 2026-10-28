import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../src/services/projects.js';
import { defineSecretBlob, SECRET_BLOB_MAX_BYTES, SecretBlobError } from '../src/services/sources/secret-blob.js';

// A stand-in for a two-part credential; the real types define theirs in their own phases.
const keyPair = defineSecretBlob({
  type: 'example',
  schema: z.object({
    v: z.literal(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(8),
    region: z.enum(['eu', 'us']).optional(),
  }),
});

const SECRET = 'TOPSECRET-do-not-leak-0123456789';

const failure = (fn: () => unknown): SecretBlobError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SecretBlobError);
    return err as SecretBlobError;
  }
  throw new Error('expected a SecretBlobError');
};

describe('defineSecretBlob', () => {
  it('parses a valid document', () => {
    expect(keyPair.parse(JSON.stringify({ v: 1, accessKeyId: 'AKIA', secretAccessKey: SECRET }))).toEqual({
      v: 1,
      accessKeyId: 'AKIA',
      secretAccessKey: SECRET,
    });
  });

  it('stores the canonical form: schema key order, unknown keys dropped, whitespace gone', () => {
    const raw = `{ "extra": "x", "secretAccessKey": "${SECRET}", "accessKeyId": "AKIA", "v": 1 }`;
    expect(keyPair.canonicalize(raw)).toBe(`{"v":1,"accessKeyId":"AKIA","secretAccessKey":"${SECRET}"}`);
  });

  it('round-trips through serialize and parse', () => {
    const value = { v: 1 as const, accessKeyId: 'AKIA', secretAccessKey: SECRET, region: 'eu' as const };
    expect(keyPair.parse(keyPair.serialize(value))).toEqual(value);
  });

  it('is a ValidationError, so the admin handler answers 400', () => {
    expect(failure(() => keyPair.parse('{}'))).toBeInstanceOf(ValidationError);
  });

  it('names the field that is wrong', () => {
    const err = failure(() => keyPair.parse(JSON.stringify({ v: 1, accessKeyId: 'AKIA' })));
    expect(err.fields).toEqual(['secretAccessKey']);
    expect(err.message).toContain('secretAccessKey');
    expect(err.message).toContain('example credential');
  });

  it('names every wrong field, once each', () => {
    const err = failure(() => keyPair.parse(JSON.stringify({ v: 2, accessKeyId: '', secretAccessKey: 'short' })));
    expect([...err.fields].sort()).toEqual(['accessKeyId', 'secretAccessKey', 'v']);
  });

  it('refuses a document without the version, or with another one', () => {
    expect(failure(() => keyPair.parse(JSON.stringify({ accessKeyId: 'A', secretAccessKey: SECRET }))).fields).toEqual(['v']);
    expect(failure(() => keyPair.parse(JSON.stringify({ v: 2, accessKeyId: 'A', secretAccessKey: SECRET }))).fields).toEqual(['v']);
  });

  it.each(['"just a string"', '42', 'null', '[1,2]'])('refuses %s as a document', (raw) => {
    expect(failure(() => keyPair.parse(raw)).message).toContain('must be a JSON object');
  });

  describe('never puts any part of the secret in an error', () => {
    const leaks = (err: SecretBlobError) => {
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain('TOPSECRET');
      expect(JSON.stringify(err.fields)).not.toContain('TOPSECRET');
    };

    it('for a field of the wrong type', () => {
      leaks(failure(() => keyPair.parse(JSON.stringify({ v: 1, accessKeyId: 7, secretAccessKey: SECRET }))));
    });

    it('for a value outside an enum', () => {
      leaks(failure(() => keyPair.parse(JSON.stringify({ v: 1, accessKeyId: 'A', secretAccessKey: SECRET, region: SECRET }))));
    });

    it('for a version that is the secret', () => {
      leaks(failure(() => keyPair.parse(JSON.stringify({ v: SECRET, accessKeyId: 'A', secretAccessKey: SECRET }))));
    });

    it('for text that is not JSON (V8 would quote the text around the fault)', () => {
      const err = failure(() => keyPair.parse(`{"v":1,"secretAccessKey":"${SECRET}" oops`));
      leaks(err);
      expect(err.message).toContain('valid JSON');
    });

    it('for a bare secret submitted instead of a document', () => {
      leaks(failure(() => keyPair.parse(SECRET)));
    });

    it('for a value serialize refuses', () => {
      leaks(failure(() => keyPair.serialize({ v: 1, accessKeyId: SECRET })));
    });
  });

  it('refuses a document over the size cap without parsing it', () => {
    const raw = JSON.stringify({ v: 1, accessKeyId: 'A', secretAccessKey: 'x'.repeat(SECRET_BLOB_MAX_BYTES) });
    expect(failure(() => keyPair.parse(raw)).message).toContain('too large');
  });
});
