#!/usr/bin/env node
import { main } from './cli/main.js';

/**
 * The `contextator` command's entry point, `bin` in package.json ([ADR-0131](../.ssot/ADR.md#adr-0131)
 * decision 1: `dist/cli.js`). It is kept this thin on purpose: the command's code lives in `src/cli/`, where
 * the tests import it without running it, and this file is the only one that starts a process.
 */
process.exitCode = await main(process.argv.slice(2));
