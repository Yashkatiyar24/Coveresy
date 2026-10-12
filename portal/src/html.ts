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

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += esc(values[i]) + strings[i + 1];
  return raw(out);
}

export function render(node: Raw): string {
  return node[RAW];
}
