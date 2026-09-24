// The three pages a visitor sees before the dashboard exists for them: /login, /setup and
// /change-password. Deliberately standalone — it imports nothing from app.js, so an anonymous
// visitor never downloads the dashboard.

const $ = (sel) => document.querySelector(sel);

/**
 * Only a path on this very server is an acceptable destination. Kept in sync by hand with
 * `src/auth/safe-next.ts` — this file ships to the browser unbundled, straight from `public/`, so
 * it cannot `import` a server-side module ([MAJOR-2], tur 2 review of
 * [ADR-0077](../../.ssot/ADR.md#adr-0077)).
 *
 * A same-origin-looking prefix check alone misses a control character elsewhere in the string: a
 * WHATWG URL parser (what the browser itself uses to resolve a redirect) strips ASCII tab/CR/LF
 * *before* it looks at slashes, so `/\t/evil.example` reads as same-origin here but resolves to
 * `//evil.example` once parsed. Rejecting control characters/backslashes outright, then re-parsing
 * against a fixed base and comparing origins, catches that the same way a browser would.
 */
function safeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  try {
    const base = 'http://safe-next.invalid';
    if (new URL(value, base).origin !== base) return '/';
    // Encoded, like the server copy: a fixed point under a second pass, and plain ASCII.
    return encodeURI(value);
  } catch {
    return '/';
  }
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const suffix = res.status === 429 && retry ? ` Try again in ${retry} s.` : '';
    throw new Error((json?.message || json?.error || `HTTP ${res.status}`) + suffix);
  }
  return json;
}

/** Wires one of the three forms: validate, post, show the error, or leave. */
function wire({ form, errorNode, submit, build, endpoint, done }) {
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;
    if (!form.reportValidity()) return;
    let body;
    try {
      body = build(new FormData(form));
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      await post(endpoint, body);
      done();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      submit.disabled = false;
    }
  });
}

const next = () => safeNext(new URLSearchParams(location.search).get('next'));

function matchingPasswords(data, field = 'newPassword') {
  const value = String(data.get(field));
  if (value !== String(data.get('confirmPassword'))) throw new Error('The two passwords do not match.');
  return value;
}

// ---------- /login ----------

wire({
  form: $('#login-form'),
  errorNode: $('#login-error'),
  submit: $('#login-submit'),
  endpoint: '/api/auth/login',
  build: (data) => ({ username: String(data.get('username')).trim(), password: String(data.get('password')) }),
  done: () => location.replace(next()),
});

const OIDC_ERROR_MESSAGES = {
  not_configured: 'Single sign-on is not available on this instance.',
  flow_expired: 'The sign-in link expired. Start again.',
  provider_denied: 'The identity provider declined the sign-in.',
  exchange_failed: 'Could not complete sign-in with the identity provider.',
  no_account: 'No account is linked to this identity yet. Ask an administrator for access.',
  provision_failed: 'Could not create an account for this identity.',
  account_disabled: 'This account has been disabled.',
  root_local_only: 'The root account signs in with its password only; single sign-on cannot be used or linked for it.',
  link_conflict: 'That single sign-on identity is already linked to a different account.',
  link_requires_session: 'Linking single sign-on needs the same signed-in session that started it. Sign in and start again from your account page.',
};

/** The codes a *linking* flow ends with: the visitor is usually still signed in, so offer the way back. */
const OIDC_LINK_ERRORS = new Set(['root_local_only', 'link_conflict', 'link_requires_session']);

// Somebody who lands on /login before anyone has set the instance up needs pointing at /setup.
if ($('#login-form')) {
  void fetch('/api/setup/status', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((status) => {
      if (status?.needsSetup) $('#login-setup-hint').hidden = false;
      if (status?.oidc?.enabled) {
        const link = $('#login-sso-link');
        link.textContent = status.oidc.buttonLabel || 'Single sign-on';
        link.href = `/api/auth/oidc/login?next=${encodeURIComponent(next())}`;
        link.hidden = false;
        $('#login-sso-divider').hidden = false;
      }
    })
    .catch(() => undefined);
  $('#login-form').elements.username.focus();

  const oidcError = new URLSearchParams(location.search).get('oidc_error');
  if (oidcError) {
    const errorNode = $('#login-error');
    errorNode.textContent = OIDC_ERROR_MESSAGES[oidcError] || 'Single sign-on failed.';
    if (OIDC_LINK_ERRORS.has(oidcError)) {
      const back = document.createElement('a');
      back.href = '/#/~tokens';
      back.textContent = 'Back to your account';
      errorNode.append(' ', back);
    }
    errorNode.hidden = false;
  }
}

// ---------- /setup ----------

wire({
  form: $('#setup-form'),
  errorNode: $('#setup-error'),
  submit: $('#setup-submit'),
  endpoint: '/api/setup',
  build: (data) => ({
    code: String(data.get('code')),
    username: String(data.get('username')).trim().toLowerCase(),
    displayName: String(data.get('displayName') ?? '').trim(),
    password: matchingPasswords(data, 'password'),
  }),
  done: () => location.replace('/'),
});
if ($('#setup-form')) $('#setup-form').elements.code.focus();

// ---------- /change-password ----------

wire({
  form: $('#change-form'),
  errorNode: $('#change-error'),
  submit: $('#change-submit'),
  endpoint: '/api/auth/password',
  build: (data) => ({ currentPassword: String(data.get('currentPassword')), newPassword: matchingPasswords(data) }),
  done: () => location.replace('/'),
});
if ($('#change-form')) {
  $('#change-form').elements.currentPassword.focus();
  $('#change-signout').addEventListener('click', async (event) => {
    event.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST', headers: { accept: 'application/json' } }).catch(() => undefined);
    location.replace('/login');
  });
}
