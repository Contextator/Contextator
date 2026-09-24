// Preloaded (`node --import`) into a command a test runs, to tell *how* that command ended.
//
// `beforeExit` fires only when the event loop has drained on its own — every handle closed, every
// pending write to a pipe flushed. `process.exit()` skips it, and so does an exit that jumps past a
// `finally` still holding a database pool. So a marker file written here, carrying `process.exitCode`,
// is evidence a command ended by setting its exit code and running out of work, which the exit code
// seen by the parent alone cannot show: `exit(1)` and `exitCode = 1` both arrive as 1.
import { writeFileSync } from 'node:fs';

const marker = process.env.NATURAL_EXIT_MARKER;
if (marker) {
  process.once('beforeExit', () => {
    writeFileSync(marker, String(process.exitCode ?? 0));
  });
}
