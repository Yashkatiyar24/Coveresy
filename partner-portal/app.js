/* Shared helpers for the partner portal pages. */
const API = window.COVERESY_API || '/api';

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401 && !path.endsWith('/login')) {
    location.href = 'login.html';
    throw new Error('signed out');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || body.error || 'Something went wrong.');
  return body;
}

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Renders the header and returns the signed-in partner, or redirects out. */
async function requirePartner(active) {
  const me = await api('/partner/me');
  document.querySelectorAll('[data-user-name]').forEach((el) => { el.textContent = me.name; });
  document.querySelectorAll('[data-user-initials]').forEach((el) => { el.textContent = initials(me.name); });
  document.querySelectorAll('[data-user-code]').forEach((el) => { el.textContent = me.agent_code; });
  document.querySelectorAll('.rail nav a').forEach((a) => {
    a.classList.toggle('on', a.dataset.nav === active);
  });
  const out = document.getElementById('logout');
  if (out) out.addEventListener('click', async () => {
    await api('/partner/logout', { method: 'POST' });
    location.href = 'login.html';
  });
  return me;
}

const money = (paise) => '₹' + ((paise || 0) / 100).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);
function monthStart() {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
