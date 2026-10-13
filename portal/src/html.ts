/**
 * Tagged template that HTML-escapes every interpolation. This is the single
 * XSS boundary for the whole app: raw(...) is the only way past it.
 */
const RAW = Symbol('raw');
type Raw = { [RAW]: string };

export function raw(s: string): Raw {
  return { [RAW]: s };
}

function esc(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'object' && RAW in (v as Raw)) return (v as Raw)[RAW];
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mount path, e.g. "/admin" when the portal is served at coveresy.com/admin.
 * Deployment configuration, fixed for the life of the isolate, not per-request
 * state — the router sets it from env on every request with the same value.
 */
let basePath = '';

export function setBasePath(p: string): void {
  basePath = p === '/' ? '' : p.replace(/\/+$/, '');
}

export function getBasePath(): string {
  return basePath;
}

/** Prefixes a site-absolute path with the mount path. Idempotent. */
export function withBase(u: string): string {
  if (!basePath || !u.startsWith('/') || u.startsWith('//')) return u;
  if (u === basePath || u.startsWith(basePath + '/')) return u;
  return basePath + u;
}

// The end of a static chunk about to be followed by a URL, e.g. `<a href="`
// then an interpolated path.
const URL_ATTR_END = /\b(?:href|action|src)="$/;
// A site-absolute URL inside an attribute. The value may run to the end of the
// chunk rather than a closing quote, as in `href="/applications/${id}"`, so the
// quote is not required. withBase does the guarding.
const URL_ATTR_ALL = /\b(href|action|src)="(\/[^"]*)/g;

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  // Prefixing happens here so every link, form and asset in the app is mounted
  // correctly from one place, rather than at 142 call sites.
  const fix = (chunk: string) =>
    basePath ? chunk.replace(URL_ATTR_ALL, (_m, attr, path) => `${attr}="${withBase(path)}`) : chunk;

  let out = fix(strings[0]);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const isUrlSlot = basePath !== '' && URL_ATTR_END.test(strings[i]);
    out += (isUrlSlot && typeof v === 'string' ? esc(withBase(v)) : esc(v)) + fix(strings[i + 1]);
  }
  return raw(out);
}

export function render(node: Raw): string {
  return node[RAW];
}
