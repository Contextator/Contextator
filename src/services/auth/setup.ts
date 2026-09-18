import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * First-run setup code. Held in memory only: writing it to the database would leave a standing
 * credential lying around, and a restart printing a fresh one is a better recovery story than
 * "find the old row". It exists only while no account does.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish: no I, O, 0, 1
const GROUPS = 3;
const GROUP_LEN = 4;

export function generateSetupCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let out = '';
    for (let i = 0; i < GROUP_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(out);
  }
  return groups.join('-');
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Case- and dash-insensitive, because this is read off a terminal and typed by hand. */
const canonical = (value: string) => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export function setupCodeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(canonical(given)), digest(canonical(expected)));
}

/** Mutable, process-local state: is setup still open, and with which code? */
export class SetupGate {
  private code: string | null = null;
  private usersExist = false;

  /** Called once at start-up with the account count. */
  arm(userCount: number, pinnedCode?: string): void {
    this.usersExist = userCount > 0;
    this.code = this.usersExist ? null : (pinnedCode ?? generateSetupCode());
  }

  get needsSetup(): boolean {
    return !this.usersExist;
  }

  get pendingCode(): string | null {
    return this.code;
  }

  verify(given: string): boolean {
    return this.code !== null && setupCodeMatches(given, this.code);
  }

  /** Called once the first account exists. Never goes back: the last root cannot be deleted. */
  complete(): void {
    this.usersExist = true;
    this.code = null;
  }

  /** The banner the operator reads out of `docker compose logs`. */
  banner(baseUrl: string): string {
    return [
      '',
      '  ┌─ Contextator first-run setup ' + '─'.repeat(28),
      '  │ No user accounts exist yet. Open ' + `${baseUrl}/setup`,
      '  │',
      `  │   Setup code:  ${this.code ?? ''}`,
      '  │',
      '  │ Valid until the first account is created. Lost it? Restart and a new one is printed.',
      '  └' + '─'.repeat(58),
      '',
    ].join('\n');
  }
}
