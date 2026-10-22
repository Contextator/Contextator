/**
 * How much Markdown one converted file may render to ([ADR-0115](../../../.ssot/ADR.md#adr-0115) §4,
 * "converted output is bounded by `MAX_CONVERTED_FILE_BYTES`").
 *
 * **`maxFileBytes` bounds the input and, until this existed, nothing bounded what a converter wrote.**
 * A converter that pads or substitutes writes more than it reads: a one-slide deck whose table has one
 * wide row and a few thousand narrow ones is padded out to the widest row, and a handful of chained
 * AsciiDoc attributes expand multiplicatively. A kilobyte of input can then render to hundreds of
 * megabytes, which neither the zip guard (it counts what is *unpacked*) nor the file-size check (it
 * counts what was *read*) sees.
 *
 * The budget is spent as the output is built, not checked afterwards: by the time a finished string
 * could be measured, the heap has already paid for it.
 */

import { DocumentExtractionError, type ExtractLimits } from './index.js';

export interface OutputBudget {
  /** Throws unless `count` more characters still fit. Spends nothing: it lets a loop refuse before it allocates. */
  reserve(count: number): void;
  /** Takes `count` characters from the budget, throwing once it is overdrawn. */
  spend(count: number): void;
}

/** A budget of `limits.maxFileBytes`, whose refusal names the file and the setting that raises it. */
export function outputBudget(relativePath: string, limits: ExtractLimits): OutputBudget {
  let left = limits.maxFileBytes;
  const tooBig = (): DocumentExtractionError =>
    new DocumentExtractionError(
      `"${relativePath}" renders to more than the ${Math.round(limits.maxFileBytes / (1024 * 1024))} MiB a converted file may be: ` +
        `its content expands far past the size of the file (wide tables, or attributes that refer to attributes). ` +
        `Simplify the file, or raise MAX_CONVERTED_FILE_BYTES if the content is real.`,
    );
  return {
    reserve(count) {
      if (count > left) throw tooBig();
    },
    spend(count) {
      left -= count;
      if (left < 0) throw tooBig();
    },
  };
}
