import { describe, expect, it } from 'vitest';
import { credentialsFor, detectProvider, sanitizeGitUrl } from '../src/services/sources/git-auth.js';

describe('git provider detection', () => {
  it('detects the hosted services from the URL and honours an explicit choice', () => {
    expect(detectProvider('https://github.com/org/repo.git')).toBe('github');
    expect(detectProvider('https://gitlab.com/org/repo.git')).toBe('gitlab');
    expect(detectProvider('https://gitlab.example.com/org/repo.git')).toBe('gitlab');
    expect(detectProvider('https://bitbucket.org/ws/repo.git')).toBe('bitbucket');
    expect(detectProvider('https://codeberg.org/org/repo.git')).toBe('gitea');
    expect(detectProvider('https://git.example.com/org/repo.git')).toBe('generic');
    expect(detectProvider('https://git.example.com/org/repo.git', 'gitea')).toBe('gitea');
    expect(detectProvider('not a url')).toBe('generic');
  });

  it('maps tokens to the username each provider expects', () => {
    expect(credentialsFor('github', 'tok')).toEqual({ username: 'x-access-token', password: 'tok' });
    expect(credentialsFor('gitlab', 'tok')).toEqual({ username: 'oauth2', password: 'tok' });
    expect(credentialsFor('bitbucket', 'tok')).toEqual({ username: 'x-token-auth', password: 'tok' });
    expect(credentialsFor('bitbucket', 'app-pass', 'alice')).toEqual({ username: 'alice', password: 'app-pass' });
    expect(credentialsFor('gitea', 'tok')).toEqual({ username: 'token', password: 'tok' });
    expect(credentialsFor('generic', 'tok', 'bob')).toEqual({ username: 'bob', password: 'tok' });
  });

  it('strips credentials pasted into the URL', () => {
    expect(sanitizeGitUrl('https://user:secret@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(sanitizeGitUrl('nonsense')).toBe('nonsense');
  });
});
