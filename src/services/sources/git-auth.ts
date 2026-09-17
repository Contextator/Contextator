/** Provider detection and HTTP basic-auth credentials for git hosting services (pure, unit-tested). */

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'generic';

export function detectProvider(url: string, configured: 'auto' | 'github' | 'gitlab' | 'bitbucket' | 'gitea' = 'auto'): GitProvider {
  if (configured !== 'auto') return configured;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
  if (host === 'bitbucket.org' || host.includes('bitbucket')) return 'bitbucket';
  if (host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')) return 'gitea';
  return 'generic';
}

/**
 * Username/password pair for token auth per provider:
 * - GitHub: `x-access-token` works for classic PATs, fine-grained PATs and App installation tokens.
 * - GitLab: `oauth2` works for OAuth tokens and personal/project access tokens.
 * - Bitbucket Cloud: repository/workspace access tokens use `x-token-auth`; app passwords need the real username.
 * - Gitea/Forgejo/Codeberg and generic servers: any username with the token as password.
 */
export function credentialsFor(provider: GitProvider, token: string, username = ''): { username: string; password: string } {
  const user = username.trim();
  switch (provider) {
    case 'github':
      return { username: user || 'x-access-token', password: token };
    case 'gitlab':
      return { username: user || 'oauth2', password: token };
    case 'bitbucket':
      return { username: user || 'x-token-auth', password: token };
    default:
      return { username: user || 'token', password: token };
  }
}

/** Strips credentials that may have been pasted into the URL so they never land in the database. */
export function sanitizeGitUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}
