// The three pages a visitor sees before the dashboard exists for them: /login, /setup and
// /change-password. Deliberately standalone — it imports nothing from app.js, so an anonymous
// visitor never downloads the dashboard.

const $ = (sel) => document.querySelector(sel);

/**
 * Only a path on this very server is an acceptable destination. `//evil.example` and `/\evil`
 * are protocol-relative URLs that browsers happily treat as another origin.
 */
function safeNext(raw) {
  if (!raw) return '/';
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
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

// Somebody who lands on /login before anyone has set the instance up needs pointing at /setup.
if ($('#login-form')) {
  void fetch('/api/setup/status', { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((status) => {
      if (status?.needsSetup) $('#login-setup-hint').hidden = false;
    })
    .catch(() => undefined);
  $('#login-form').elements.username.focus();
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
