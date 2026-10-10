import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

// The image is Linux; macOS does not ship setsid. Run the actual Compose command with a
// slow stand-in for npm, including a descendant, to exercise TERM while wait is pending.
it.skipIf(process.platform !== 'linux')(
  'stops the backup process group and removes only scheduled scratch files',
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'contextator-schedule-'));
    const data = path.join(dir, 'data');
    const scratch = path.join(data, '.scheduled-backup-staging');
    const bin = path.join(dir, 'bin');
    const overlay = parse(await readFile(path.join(__dirname, '..', 'docker-compose.backup.yml'), 'utf8'));
    const command = overlay.services.backup.command[0].replaceAll('$$', '$');
    await mkdir(bin);
    await mkdir(path.join(data, 'backups'), { recursive: true });
    await mkdir(path.join(data, '.backup-manual'));
    await mkdir(path.join(scratch, '.backup-stale'), { recursive: true });
    const stale = path.join(data, 'backups', 'contextator-backup-2026-01-01T00-00-00Z.tar.gz.partial');
    await writeFile(stale, 'partial');
    await writeFile(path.join(data, 'backups', 'manual.tar.gz.partial'), 'manual');
    await writeFile(
      path.join(bin, 'npm'),
      `#!/bin/sh
set -e
[ ! -e "${stale}" ]
[ ! -d "$BACKUP_STAGING_DIR/.backup-stale" ]
mkdir "$BACKUP_STAGING_DIR/.backup-current"
touch "$4"
sleep 300 &
echo $! > "$DATA_DIR/descendant"
wait
`,
      { mode: 0o755 },
    );
    const child = spawn('/bin/sh', ['-ec', command], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DATA_DIR: data,
        BACKUP_STAGING_DIR: scratch,
        BACKUP_INTERVAL_SECONDS: '300',
        BACKUP_KEEP: '7',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    let descendant = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          descendant = Number(await readFile(path.join(data, 'descendant'), 'utf8'));
          break;
        } catch {
          await delay(20);
        }
      }
      expect(descendant, errors).toBeGreaterThan(0);
      child.kill('SIGTERM');
      expect(await Promise.race([exited, delay(5000).then(() => 'timeout')]), errors).toBe(0);
      expect(await readdir(scratch)).toEqual([]);
      expect(await readdir(path.join(data, 'backups'))).toEqual(['manual.tar.gz.partial']);
      expect(await readdir(data)).toContain('.backup-manual');
      // A terminated child can briefly remain as a zombie until the container init reaps it.
      const state = await readFile(`/proc/${descendant}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(!state || state.slice(state.lastIndexOf(')') + 2).startsWith('Z')).toBe(true);
    } finally {
      child.kill('SIGKILL');
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  10000,
);
