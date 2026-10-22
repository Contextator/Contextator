/**
 * A small ZIP reader for the OOXML types (`.pptx`, `.xlsx`) — [ADR-0115](../../../.ssot/ADR.md#adr-0115).
 *
 * **Why this is not `jszip`.** `jszip` is in the tree only as mammoth's dependency; `package.json` does
 * not declare it, so importing it here would make an undeclared package load-bearing for two more
 * formats. This product reads exactly two things from an archive — the central directory and the few
 * parts the converters name — and both fit in under two hundred lines with the guards written where
 * they can be read.
 *
 * **The guards are the point.** `maxUnpackedBytes` (`MAX_DOCX_UNPACKED_BYTES`, documented as covering
 * every OOXML type) is applied twice:
 *
 * 1. against what the central directory *declares*, before anything is inflated — an honest large file
 *    is turned away without costing a byte;
 * 2. against what each part *actually* inflates to, because the declared size is a field the author of
 *    the archive writes. Inflation runs with `maxOutputLength` set to what is left of the budget, so a
 *    part that lies stops at the ceiling instead of spending the heap to find out. Only the parts a
 *    converter asks for are ever inflated, and every one of them draws on the same running total.
 */

import { inflateRawSync } from 'node:zlib';
import { DocumentExtractionError, type ExtractLimits } from './index.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65 535. */
const EOCD_SEARCH = 22 + 0xffff;
/** A field of all ones is ZIP64's "look in the extra field"; this reader does not, and says so. */
const ZIP64_MARKER = 0xffffffff;
/** General-purpose flag bit 0: the part is encrypted. */
const FLAG_ENCRYPTED = 0x1;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  offset: number;
  compressedSize: number;
  declaredSize: number;
}

/** Every OOXML file is a zip, and every zip starts `PK\x03\x04`. */
export function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export interface ZipArchive {
  has(name: string): boolean;
  /** Every part name, in directory order. */
  names(): string[];
  /** The part's bytes, inflated under the shared budget; `null` when the archive has no such part. */
  read(name: string): Buffer | null;
  /** The part as UTF-8 text without a BOM; `null` when the archive has no such part. */
  readText(name: string): string | null;
}

/**
 * Opens an archive and applies the declared-size refusal. `label` names the format in the message
 * ("PowerPoint presentation"), `relativePath` names the file.
 */
export function openZip(bytes: Buffer, relativePath: string, label: string, limits: ExtractLimits): ZipArchive {
  if (!isZip(bytes)) {
    throw new DocumentExtractionError(`"${relativePath}" is not a ${label} — it is not a zip archive. Re-save it in the Office Open XML format.`);
  }

  const from = Math.max(0, bytes.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  const unreadable = (): DocumentExtractionError =>
    new DocumentExtractionError(`"${relativePath}" is not a readable zip archive, so it is not a ${label}.`);
  if (eocd === -1) throw unreadable();

  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  if (at === ZIP64_MARKER || count === 0xffff) {
    throw new DocumentExtractionError(`"${relativePath}" is a ZIP64 archive, which is far past the size a ${label} reaches; it is not indexed.`);
  }

  const entries = new Map<string, ZipEntry>();
  let declared = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw unreadable();
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    if (at + 46 + nameLength > bytes.length) throw unreadable();
    const entry: ZipEntry = {
      name: bytes.toString('utf8', at + 46, at + 46 + nameLength),
      flags: bytes.readUInt16LE(at + 8),
      method: bytes.readUInt16LE(at + 10),
      compressedSize: bytes.readUInt32LE(at + 20),
      declaredSize: bytes.readUInt32LE(at + 24),
      offset: bytes.readUInt32LE(at + 42),
    };
    if (entry.declaredSize === ZIP64_MARKER || entry.compressedSize === ZIP64_MARKER || entry.offset === ZIP64_MARKER) {
      throw new DocumentExtractionError(`"${relativePath}" uses ZIP64 sizes, which is far past what a ${label} reaches; it is not indexed.`);
    }
    declared += entry.declaredSize;
    // The first of two parts with one name wins, so a later duplicate cannot replace what a reader of
    // the directory saw first.
    if (!entries.has(entry.name)) entries.set(entry.name, entry);
    at += 46 + nameLength + extraLength + commentLength;
  }

  const tooBig = (what: string): DocumentExtractionError =>
    new DocumentExtractionError(
      `"${relativePath}" is a ${(bytes.byteLength / 1024).toFixed(0)} KiB file whose parts ${what}, over the ` +
        `${(limits.maxUnpackedBytes / (1024 * 1024)).toFixed(0)} MiB an Office document may unpack to. A real one does not compress like that; ` +
        `raise MAX_DOCX_UNPACKED_BYTES if this one really does, or remove the file from the source.`,
    );
  // The cheap refusal first: nothing has been inflated yet.
  if (declared > limits.maxUnpackedBytes) throw tooBig('declare that they unpack past the limit');

  let spent = 0;
  const read = (name: string): Buffer | null => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & FLAG_ENCRYPTED) {
      throw new DocumentExtractionError(
        `"${relativePath}" is password-protected, so it cannot be read; remove the protection or leave it out of the source.`,
      );
    }
    const header = entry.offset;
    if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_SIGNATURE) throw unreadable();
    const dataAt = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
    const end = Math.min(dataAt + entry.compressedSize, bytes.length);
    if (dataAt > bytes.length) throw unreadable();

    const remaining = limits.maxUnpackedBytes - spent;
    let out: Buffer;
    if (entry.method === METHOD_STORED) {
      if (end - dataAt > remaining) throw tooBig('actually unpack past the limit');
      out = bytes.subarray(dataAt, end);
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        out = inflateRawSync(bytes.subarray(dataAt, end), { maxOutputLength: Math.max(1, remaining) });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig('actually unpack past the limit');
        throw new DocumentExtractionError(`"${relativePath}" has a damaged part ("${name}") and cannot be read as a ${label}.`);
      }
      // `maxOutputLength` cannot be zero, so an exhausted budget still allows one byte: refuse it here.
      if (out.byteLength > remaining) throw tooBig('actually unpack past the limit');
    } else {
      throw new DocumentExtractionError(
        `"${relativePath}" compresses "${name}" with a method this product does not read; re-save it as a standard ${label}.`,
      );
    }
    spent += out.byteLength;
    return out;
  };

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read,
    readText: (name) => {
      const data = read(name);
      return data === null ? null : data.toString('utf8').replace(/^﻿/, '');
    },
  };
}
