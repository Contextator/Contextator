/**
 * `npm run warm-model` — put the configured embedding model in `MODEL_CACHE_DIR` and prove it landed.
 *
 *   npm run warm-model
 *   EMBEDDING_MODEL=intfloat/multilingual-e5-base npm run warm-model
 *
 * Two callers. CI's `check` job runs it on a cache miss, because the two tests that load a real model
 * — the tokenizer on Turkish in `test/chunker.test.ts`, and both sides of one sentence in
 * `test/embedding-prefixes.test.ts` — used to skip there on every run and report green. And a
 * contributor runs it once so those same tests stop skipping on their machine.
 *
 * It deliberately does not fetch anything itself. `createEmbeddingProvider` and `warmup()` are the
 * path `src/server.ts` takes on boot and `scripts/eval.ts` takes before it measures; a second
 * downloader here would be a second thing to keep in step with `EMBEDDING_DTYPE`, offline mode and the
 * cache layout, and the first time they disagreed the tests would go back to skipping.
 *
 * What it adds is the assertion at the end: the files the tests gate on, checked by the same paths
 * `test/support/model-cache.ts` checks, so "the warm-up succeeded" cannot mean anything other than
 * "those tests will now run". A model whose repository has no `onnx/model.onnx` under this dtype is a
 * failure here, loudly, rather than three silent skips an hour later.
 */
import 'dotenv/config';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import type { Logger } from '../src/context.js';
import { createEmbeddingProvider } from '../src/services/embeddings/index.js';

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Only the model's own progress lines, which are the ones worth watching during a download. */
const warmLogger: Logger = {
  level: 'info',
  fatal: () => {},
  error: (...args: unknown[]) => log(`  ! ${JSON.stringify(args[0])}`),
  warn: (...args: unknown[]) => log(`  ! ${JSON.stringify(args[0])}`),
  info: (obj: unknown, msg?: unknown) => {
    if (typeof msg === 'string') log(`  · ${msg} ${JSON.stringify(obj)}`);
  },
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => warmLogger,
};

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

async function main(): Promise<void> {
  // `loadConfig` is the product's own parser, so the model, the dtype and the cache directory are
  // exactly the ones a server would run with. It refuses an environment with no database and exits
  // rather than throwing, so it gets a placeholder: nothing below opens a connection.
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://warm:warm@127.0.0.1:5432/warm',
  });

  if (config.EMBEDDING_PROVIDER !== 'local') {
    log(`EMBEDDING_PROVIDER=${config.EMBEDDING_PROVIDER} downloads nothing; there is no cache to warm.`);
    return;
  }
  if (config.EMBEDDING_OFFLINE) {
    log('EMBEDDING_OFFLINE=1 forbids the download this script exists to make. Unset it and run again.');
    process.exitCode = 2;
    return;
  }

  const cacheDir = path.resolve(config.MODEL_CACHE_DIR);
  const provider = createEmbeddingProvider(config, warmLogger);
  log(`warm-model: ${provider.id} into ${cacheDir} (a cold run downloads a few hundred megabytes)`);

  const started = Date.now();
  await provider.warmup();
  log(`warm-model: loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // The whole point of the script. `onnx/model.onnx` is what `embedding-prefixes.test.ts` gates on and
  // `tokenizer.json` is what `chunker.test.ts` gates on; a warm-up that leaves either absent has not
  // done its job, whatever the load said. The dtype is in the filename upstream — fp16 and q8 write
  // `model_fp16.onnx` and `model_quantized.onnx` — so this is also where a dtype those tests were never
  // written for announces itself, instead of turning into a skip.
  const required = [path.join(cacheDir, config.EMBEDDING_MODEL, 'tokenizer.json'), path.join(cacheDir, config.EMBEDDING_MODEL, 'onnx', 'model.onnx')];
  const missing = required.filter((file) => !existsSync(file));
  for (const file of required.filter((file) => existsSync(file))) {
    log(`warm-model: ${path.relative(process.cwd(), file)} ${mb(statSync(file).size)}`);
  }
  if (missing.length > 0) {
    log(
      `warm-model: the cache is not the shape the tests check. Missing:\n  ${missing.join('\n  ')}\n` +
        `EMBEDDING_DTYPE=${config.EMBEDDING_DTYPE} may write a different filename, or ${config.EMBEDDING_MODEL} may not publish one.`,
    );
    process.exitCode = 2;
    return;
  }
  log('warm-model: the model tests in `npm test` will run.');
}

await main();
