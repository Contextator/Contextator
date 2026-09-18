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
const canonical = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export function setupCodeMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(canonical(given)), digest(canonical(expected)));
}

/** Mutable, process-local state: is setup still open, and with which code? */
export class SetupGate {
  private code: string | null = null;
  private usersExist = false;
  /** True when the operator chose the code in .env rather than letting the server generate one. */
  private pinned = false;

  /** Called once at start-up with the account count. */
  arm(userCount: number, pinnedCode?: string): void {
    this.usersExist = userCount > 0;
    this.pinned = Boolean(pinnedCode) && !this.usersExist;
    this.code = this.usersExist ? null : (pinnedCode ?? generateSetupCode());
  }

  get codeIsPinned(): boolean {
    return this.pinned;
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
    this.pinned = false;
  }

  /**
   * The one thing an operator has to *read* out of the log, so it is drawn as a box and written
   * straight to stdout rather than through the JSON logger.
   *
   * A pinned code is never echoed: the operator already has it in their own `.env`, and repeating
   * their secret into the log — where it outlives the setup window — would be a poor trade for
   * telling them something they know.
   */
  banner(baseUrl: string): string {
    const title = ' Contextator first-run setup ';
    const body = [
      'No user accounts exist yet; the dashboard is waiting for its first one.',
      '',
      `  Open   ${baseUrl}/setup`,
      this.pinned ? '  Code   the SETUP_CODE you set in .env' : `  Code   ${this.code ?? ''}`,
      '',
      this.pinned
        ? 'Clear SETUP_CODE to have a fresh code generated and printed here instead.'
        : 'A new code is printed on every start until that first account exists.',
    ];

    const width = Math.max(title.length, ...body.map((line) => line.length)) + 2;
    const top = `┌─${title}${'─'.repeat(width - title.length - 1)}┐`;
    const middle = body.map((line) => `│ ${line.padEnd(width - 1)}│`);
    const bottom = `└${'─'.repeat(width)}┘`;
    return ['', top, ...middle, bottom, ''].join('\n');
  }
}
