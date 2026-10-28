import type { z } from 'zod';
import { ValidationError } from '../projects.js';

/**
 * The one JSON document a credential-bearing source type keeps in `secret_enc`
 * ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 8, amending
 * [ADR-0091](../../../.ssot/ADR.md#adr-0091)).
 *
 * A credential with more than one part (an S3 key pair, a Google service account) is not spread over
 * new columns: it is a JSON object with a `v` field, defined by the type's own entry, sent as the API's
 * `secret` string, **validated and stored in canonical form**, and encrypted as a whole by the same
 * envelope as a single token. A type with a one-part credential (git, Notion, Confluence, GitHub) does
 * not use this at all.
 *
 * **What an error says.** `400 invalid_request` names the field and the rule, and never a value:
 * a rejected credential is by definition one the operator just pasted, so echoing any part of it would
 * put a secret into a response, a log line and a browser. That is also why a JSON syntax error is not
 * passed through — V8's `SyntaxError` quotes the text around the fault.
 *
 * This module defines the mechanism and no type. A type joins `CREDENTIAL_SOURCE_TYPES`
 * (`encrypted-fields.ts`) and defines its schema in its own phase.
 */

/** A credential document is a few hundred bytes; a Google key file is about 2.4 KB. Anything near this is not one. */
export const SECRET_BLOB_MAX_BYTES = 64 * 1024;

/** A rejected credential: names the type and the offending fields, never a value. Maps to `400 invalid_request`. */
export class SecretBlobError extends ValidationError {
  /** Dotted names of the fields the document got wrong; empty when the document as a whole is wrong. */
  readonly fields: readonly string[];
  constructor(message: string, fields: readonly string[] = []) {
    super(message);
    this.name = 'SecretBlobError';
    this.fields = fields;
  }
}

export interface SecretBlob<T> {
  /** The source type this credential belongs to; only used in messages. */
  readonly type: string;
  /** Parses and validates the stored or submitted document. Throws {@link SecretBlobError}. */
  parse(raw: string): T;
  /** Validates a value and returns the canonical string to encrypt. Throws {@link SecretBlobError}. */
  serialize(value: unknown): string;
  /** `serialize(parse(raw))`: what to store when the API's `secret` string arrives. */
  canonicalize(raw: string): string;
}

/**
 * Binds a type's schema to the parse/serialize pair.
 *
 * The schema must carry the `v` field (`z.literal(1)` for a first version), so that a later shape can be
 * told from this one. Keys the schema does not name are dropped, not kept: the canonical form is the
 * schema's output, in the schema's key order, and nothing else of what was submitted is ever stored.
 */
export function defineSecretBlob<S extends z.ZodType>(definition: { type: string; schema: S }): SecretBlob<z.output<S>> {
  const { type, schema } = definition;
  const label = `${type} credential`;

  const check = (input: unknown): z.output<S> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new SecretBlobError(`The ${label} must be a JSON object`);
    }
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.')).filter(Boolean))];
    // `issue.message` is zod's own wording for the rule that failed ("expected string, received number"),
    // which names types and limits, not the offending value.
    const detail = result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new SecretBlobError(`The ${label} is invalid: ${detail}`, fields);
  };

  const parse = (raw: string): z.output<S> => {
    if (Buffer.byteLength(raw, 'utf8') > SECRET_BLOB_MAX_BYTES) {
      throw new SecretBlobError(`The ${label} is too large (over ${SECRET_BLOB_MAX_BYTES} bytes)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately not `err.message`: V8 quotes the text around the fault.
      throw new SecretBlobError(`The ${label} must be a valid JSON document`);
    }
    return check(parsed);
  };

  return {
    type,
    parse,
    serialize: (value) => JSON.stringify(check(value)),
    canonicalize: (raw) => JSON.stringify(parse(raw)),
  };
}
