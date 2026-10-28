import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidIbanChecksum, isValidTckn, MAX_FINDINGS_PER_DOCUMENT, PII_RULES, scanText } from '../src/services/pii-rules.js';

/**
 * The PII rule set ([ADR-0130](../.ssot/ADR.md#adr-0130) decision 1, user decision D19). Pure text in, findings out, so
 * everything that matters about the rules is checked here without a database: what is a finding and what is not,
 * where it is, what its preview shows, and that no rule can be made to run for long by the text it is given.
 *
 * The values are the providers' published examples and numbers that pass a public checksum and belong to nobody.
 * A GitHub token is assembled at run time from parts, so that no string in this repository is shaped like one.
 */

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/pii/${name}`, import.meta.url), 'utf8');

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const TCKN = '10000000146';
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';
const GITHUB = ['gh', 'p_', 'a1B2'.repeat(9)].join('');
const GITHUB_PAT = ['github', '_pat_', 'Zz9Y'.repeat(20), 'AbCd'.slice(0, 2)].join('');
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const rulesOf = (text: string): string[] => scanText(text).findings.map((f) => f.rule);

describe('the rule set', () => {
  it('names the six rules of D19 and nothing else', () => {
    expect([...PII_RULES]).toEqual(['aws_access_key', 'github_token', 'private_key', 'jwt', 'tckn', 'iban']);
  });

  it('finds the AWS key, the JWT and the private key header in the runbook fixture, at their lines', () => {
    const found = scanText(fixture('runbook.md')).findings;
    expect(found.map((f) => [f.rule, f.line])).toEqual([
      ['aws_access_key', 8],
      ['jwt', 14],
      ['private_key', 18],
    ]);
    const aws = found[0];
    expect(fixture('runbook.md').slice(aws.start, aws.start + aws.length)).toBe(AWS);
    expect(aws.col).toBe('The deploy role uses the access key `'.length + 1);
  });

  it('finds the valid citizen number and IBANs in the citizens fixture, and not the typos or the order number', () => {
    const found = scanText(fixture('citizens.md')).findings;
    expect(found.map((f) => [f.rule, f.normalized])).toEqual([
      ['tckn', TCKN],
      ['iban', 'TR330006100519786457841326'],
      ['iban', 'DE89370400440532013000'],
    ]);
  });

  it('finds a GitHub token of both shapes', () => {
    expect(rulesOf(`token: ${GITHUB}`)).toEqual(['github_token']);
    expect(rulesOf(`token: ${GITHUB_PAT}`)).toEqual(['github_token']);
    expect(GITHUB_PAT.length).toBe('github_pat_'.length + 82);
  });

  it('does not take a lookalike for a token', () => {
    expect(rulesOf(`xAKIAIOSFODNN7EXAMPLE`)).toEqual([]);
    expect(rulesOf(`AKIAIOSFODNN7EXAMPLE0`)).toEqual([]);
    expect(rulesOf(`AKIA1234`)).toEqual([]);
    expect(rulesOf(`${GITHUB}x`)).toEqual([]);
    expect(rulesOf(`ghp_short`)).toEqual([]);
  });

  it('reads an access key written after an underscore or an equals sign, as an environment file has it', () => {
    expect(rulesOf(`AWS_ACCESS_KEY_ID=${AWS}`)).toEqual(['aws_access_key']);
  });
});

describe('the citizen number', () => {
  it('passes only with both check digits', () => {
    expect(isValidTckn(TCKN)).toBe(true);
    expect(isValidTckn('10000000147')).toBe(false); // last digit
    expect(isValidTckn('10000000156')).toBe(false); // tenth digit
    expect(isValidTckn('00000000000')).toBe(false); // first digit
    expect(isValidTckn('1000000014')).toBe(false); // length
  });

  it('is not found inside a longer number or a word', () => {
    expect(rulesOf(`${TCKN}0`)).toEqual([]);
    expect(rulesOf(`0${TCKN}`)).toEqual([]);
    expect(rulesOf(`id${TCKN}`)).toEqual([]);
    expect(rulesOf(`${TCKN}ab`)).toEqual([]);
    expect(rulesOf(`tckn: ${TCKN}.`)).toEqual(['tckn']);
  });
});

describe('the IBAN', () => {
  it('passes mod-97 and the length of its country', () => {
    expect(isValidIbanChecksum('GB82WEST12345698765432')).toBe(true);
    expect(isValidIbanChecksum('GB82WEST12345698765433')).toBe(false);
    expect(rulesOf('GB82 WEST 1234 5698 7654 32')).toEqual(['iban']);
    expect(rulesOf('GB82WEST12345698765432')).toEqual(['iban']);
    // Valid check digits for a length no country uses.
    expect(rulesOf('GB82 WEST 1234 5698 7654 3')).toEqual([]);
    // A country that has no IBAN.
    expect(rulesOf('US64 SVBK US6S 3300 9589 23')).toEqual([]);
  });

  it('is not found when the check digits are wrong', () => {
    expect(rulesOf('TR33 0006 1005 1978 6457 8413 27')).toEqual([]);
  });

  it('stops where the IBAN stops when a word follows it', () => {
    const [found] = scanText(`Pay to ${IBAN} FROM the account`).findings;
    expect(found.rule).toBe('iban');
    expect(found.length).toBe(IBAN.length);
  });

  it('is keyed without its spaces', () => {
    expect(scanText(IBAN).findings[0].normalized).toBe('TR330006100519786457841326');
  });
});

describe('the JWT', () => {
  it('needs a header that is JSON and names an algorithm', () => {
    expect(rulesOf(`Authorization: Bearer ${JWT}`)).toEqual(['jwt']);
    // `{"typ":"JWT"}` has no `alg`; and `eyJ…` that is not base64url JSON at all.
    expect(rulesOf('eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxIn0.c2ln')).toEqual([]);
    expect(rulesOf('eyJhYmNkZWZn.eyJhYmNkZWZn.c2lnbmF0dXJl')).toEqual([]);
  });
});

describe('the private key', () => {
  it('is reported at its header, and the preview is the header', () => {
    for (const header of [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    ]) {
      const [found] = scanText(`before\n${header}\nbody\n`).findings;
      expect(found.rule).toBe('private_key');
      expect(found.preview).toBe(header);
      expect(found.length).toBe(header.length);
      expect(found.line).toBe(2);
    }
    expect(rulesOf('-----BEGIN PUBLIC KEY-----')).toEqual([]);
    expect(rulesOf('-----BEGIN CERTIFICATE-----')).toEqual([]);
  });

  it('is keyed by its body, so two different keys of one kind are two values', () => {
    const a = scanText('-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----').findings[0].normalized;
    const b = scanText('-----BEGIN PRIVATE KEY-----\nCCCC\nDDDD\n-----END PRIVATE KEY-----').findings[0].normalized;
    const again = scanText('x\n-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----').findings[0].normalized;
    expect(a).toBe('AAAABBBB');
    expect(b).not.toBe(a);
    expect(again).toBe(a);
  });
});

describe('the preview', () => {
  const samples = [AWS, GITHUB, JWT, TCKN, IBAN];

  it('shows at most four characters of the value beyond a fixed prefix', () => {
    const text = samples.join('\n');
    const byRule = new Map(scanText(text).findings.map((f) => [f.rule, f]));
    expect(byRule.get('aws_access_key')?.preview).toBe('AKIA…MPLE');
    expect(byRule.get('github_token')?.preview).toBe('ghp_…' + GITHUB.slice(-4));
    expect(byRule.get('jwt')?.preview).toBe('eyJhbGc…');
    expect(byRule.get('tckn')?.preview).toBe('*********46');
    expect(byRule.get('iban')?.preview).toBe('TR…1326');
  });

  it('never contains the value, and never more of it than the rule allows', () => {
    for (const finding of scanText(samples.join('\n')).findings) {
      expect(finding.preview).not.toContain(finding.normalized);
      const visible = finding.preview.replace(/[*…]/g, '');
      // Prefixes are `AKIA`, `ghp_`, `eyJ`, `TR`; the rest is at most four characters.
      expect(visible.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('positions', () => {
  it('counts the column in code points and the offset in UTF-16 code units', () => {
    const text = `line one\n😀😀 ${AWS}`;
    const [found] = scanText(text).findings;
    expect(found.line).toBe(2);
    expect(found.col).toBe(4);
    expect(found.start).toBe('line one\n'.length + 5);
    expect(text.slice(found.start, found.start + found.length)).toBe(AWS);
  });

  it('reports an IBAN and a citizen number on separate lines as two findings', () => {
    const text = `${IBAN}\n${TCKN}`;
    expect(rulesOf(text)).toEqual(['iban', 'tckn']);
  });

  it('keeps the first findings in reading order when there are more than the ceiling, and still counts all', () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_DOCUMENT + 25 }, () => TCKN).join('\n');
    const outcome = scanText(many);
    expect(outcome.findings).toHaveLength(MAX_FINDINGS_PER_DOCUMENT);
    expect(outcome.total).toBe(MAX_FINDINGS_PER_DOCUMENT + 25);
    expect(outcome.capped).toBe(true);
    expect(outcome.findings.at(-1)?.line).toBe(MAX_FINDINGS_PER_DOCUMENT);
    expect(scanText(TCKN).capped).toBe(false);
  });

  it('finds nothing in plain prose', () => {
    expect(scanText('Nothing to see here. Order 12345678901 shipped on 2026-10-28.').total).toBe(0);
  });
});

/**
 * "Linear time" is a claim about the worst input, so each rule is given a megabyte built to hurt it: a run its
 * pattern could start from at every position, a prefix repeated, and a candidate that fails at its very end. The limit
 * is generous (a scan of a megabyte takes tens of milliseconds); a quadratic rule would take minutes.
 */
describe('hostile input', () => {
  const MEGABYTE = 1024 * 1024;
  const repeat = (unit: string): string => unit.repeat(Math.ceil(MEGABYTE / unit.length)).slice(0, MEGABYTE);
  const LIMIT_MS = 2000;

  const cases: Array<[string, string]> = [
    ['one long run of the key alphabet', repeat('A')],
    ['the AWS prefix over and over', repeat('AKIA')],
    ['a GitHub prefix without a token', repeat('ghp_')],
    ['a GitHub prefix with a near-token', repeat(`ghp_${'a'.repeat(35)} `)],
    ['a PEM marker without an end', repeat('-----BEGIN ')],
    ['a PEM marker with a long uppercase run', repeat('-----BEGIN AAAA AAAA AAAA AAAA AAAA PRIVATE KE ')],
    ['a JWT prefix, no dots', repeat('eyJ')],
    ['JWT parts with no signature', repeat('eyJhYmNkZWY.')],
    ['an unbroken base64url run behind a JWT start', `eyJ${repeat('a')}`],
    ['digits with no end', repeat('1')],
    ['ten-digit runs', repeat('1234567890 ')],
    ['an IBAN start that fails at its last group', repeat('GB82 WEST 1234 5698 7654 3! ')],
    ['IBAN groups without end', repeat('AB12 CD34 ')],
    ['citizen numbers that all pass', repeat(`${TCKN}\n`)],
    ['IBANs that all pass', repeat(`${IBAN}\n`)],
    ['JWTs that all pass', repeat(`${JWT}\n`)],
    ['a line of one megabyte with a finding at the end', `${repeat('x')}${TCKN}`],
  ];

  it.each(cases)('takes less than two seconds over a megabyte of %s', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(MEGABYTE);
    const started = performance.now();
    scanText(text);
    const elapsed = performance.now() - started;
    // The figure goes to the report (`08a-pii-scan.rapor.md`); the assertion is the limit.
    console.info(`pii-rules hostile ${_name}: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(LIMIT_MS);
  });
});
