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
 * - Bitbucket Cloud: repository/workspace access tokens use `x-token-auth`; an API token needs the Bitbucket
 *   username, or `x-bitbucket-api-token-auth`, in the Username field.
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

/**
 * The address of one file **at one commit** on the hosting service, or `null` when the host is not one
 * whose layout is known ([ADR-0116](../../../.ssot/ADR.md#adr-0116)). A commit-sha permalink rather than a
 * branch link: it points at the content that was indexed even after the branch moves or the file is
 * renamed. An unrecognised (`generic`) host gets no link rather than a guessed one.
 *
 * The remote goes through `sanitizeGitUrl` first, and the result is rebuilt from origin and path alone, so
 * credentials, query strings and fragments in the configured URL cannot reach the link (ADR-0075).
 */
export function blobUrl(remote: string, provider: GitProvider, sha: string, filePath: string): string | null {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  let u: URL;
  try {
    u = new URL(sanitizeGitUrl(remote));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const repo = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (repo === '' || repo === '/') return null;
  const file = filePath
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  if (file === '') return null;
  const base = `${u.protocol}//${u.host}${repo}`;
  switch (provider) {
    case 'github':
      return `${base}/blob/${sha}/${file}`;
    case 'gitlab':
      return `${base}/-/blob/${sha}/${file}`;
    case 'bitbucket':
      return `${base}/src/${sha}/${file}`;
    case 'gitea':
      return `${base}/src/commit/${sha}/${file}`;
    default:
      return null;
  }
}
