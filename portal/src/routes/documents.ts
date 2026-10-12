import { get, post } from '../router.ts';
import { html, raw } from '../html.ts';
import { badge, errorPage, flash, numh, page, table, flashFromUrl } from '../ui.ts';
import { audit } from '../audit.ts';
import { can, hex, randomId } from '../auth.ts';
import { num, visibilityScope } from '../db.ts';
import { assess, loadApp, syncDocState } from '../service.ts';
import type { AppRow } from '../service.ts';
import type { DocAssessment } from '../rules.ts';
import { DOC_LABELS, DOC_TYPES, label } from '../types.ts';
import type { Ctx, DocType } from '../types.ts';

/** §6.2: only these three, checked by extension, declared type AND magic bytes. */
const ALLOWED: Record<string, { ext: string; magic: number[][] }> = {
  'application/pdf': { ext: 'pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  'image/jpeg': { ext: 'jpg', magic: [[0xff, 0xd8, 0xff]] },
  'image/png': { ext: 'png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
};

function sniff(bytes: Uint8Array): string | null {
  for (const [mime, spec] of Object.entries(ALLOWED)) {
    for (const sig of spec.magic) {
      if (sig.every((b, i) => bytes[i] === b)) return mime;
    }
  }
  return null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

type DocRow = Awaited<ReturnType<typeof import('../service.ts')['currentDocs']>>[number];

/* ------------------------------------------------------- detail panel UI --- */

export function docPanel(ctx: Ctx, app: AppRow, a: DocAssessment, docs: DocRow[]) {
  const mayUpload = can(ctx.user, 'upload_documents', ctx.settings);
  const mayVerify = can(ctx.user, 'verify_documents', ctx.settings);
  const byType = new Map(docs.map((d) => [d.doc_type, d]));
  const pct = a.requiredTotal ? Math.round((a.requiredUploaded / a.requiredTotal) * 100) : 100;

  const rows = DOC_TYPES.map((t) => {
    const doc = byType.get(t);
    const mandatory = a.required.includes(t);
    return html`<div class="doc">
      <div class="meta">
        <b>${DOC_LABELS[t]} <span class="tag ${mandatory ? 'mand' : 'opt'}">${mandatory ? 'Mandatory' : 'Optional'}</span></b>
        ${doc
          ? html`${badge(doc.status)}
            <small>${doc.original_name} · ${doc.mime_type} · ${humanSize(doc.size_bytes)} · v${doc.version}</small>
            <small>Uploaded ${doc.uploaded_at} by ${doc.uploaded_by_name ?? 'unknown'}</small>
            ${doc.verified_at ? html`<small>Verified ${doc.verified_at} by ${doc.verified_by_name ?? 'unknown'}</small>` : ''}
            ${doc.notes ? html`<small><b>Note:</b> ${doc.notes}</small>` : ''}`
          : html`${badge('missing')}<small>No file attached.</small>`}
      </div>
      <div class="act">
        ${doc ? html`<a class="btn ghost sm" href="/documents/${doc.id}/download">View</a>` : ''}
        ${mayUpload
          ? html`<form method="post" action="/applications/${app.id}/documents" enctype="multipart/form-data" class="act">
              <input type="hidden" name="doc_type" value="${t}">
              <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png" required style="width:190px">
              <button class="sm ghost" type="submit">${doc ? 'Replace' : 'Upload'}</button>
            </form>`
          : ''}
        ${doc && mayVerify && doc.status !== 'verified'
          ? html`<form method="post" action="/documents/${doc.id}/verify" class="inline">
              <button class="sm" type="submit">Verify</button></form>`
          : ''}
        ${doc && mayVerify && doc.status !== 'rejected'
          ? html`<form method="post" action="/documents/${doc.id}/reject" class="act"
                   onsubmit="return confirm('Reject this document?')">
              <input name="notes" placeholder="Rejection reason" required maxlength="300" style="width:170px">
              <button class="sm danger" type="submit">Reject</button></form>`
          : ''}
        ${doc && mayUpload
          ? html`<form method="post" action="/documents/${doc.id}/remove" class="inline"
                   onsubmit="return confirm('Remove this document? The audit record is kept.')">
              <button class="sm ghost" type="submit">Remove</button></form>`
          : ''}
      </div>
    </div>`;
  });

  return html`<div class="card">
    <h2>Documents &amp; Attachments</h2>
    <p class="sub">${label(app.category)} rules apply. ${a.summary}.</p>
    <div class="progress"><i style="width:${pct}%"></i></div>
    ${a.missing.length
      ? html`<p class="missinglist"><b>Missing mandatory:</b> ${a.missing.map((d) => DOC_LABELS[d]).join(', ')}</p>`
      : html`<p class="missinglist" style="color:var(--good)"><b>All mandatory documents uploaded.</b></p>`}
    ${a.awaitingVerification.length
      ? html`<p class="sub" style="margin:4px 0 0">Uploaded but not yet verified: ${a.awaitingVerification.map((d) => DOC_LABELS[d]).join(', ')}</p>`
      : ''}
    ${a.rejected.length
      ? html`<p class="missinglist">Rejected, must be resolved: ${a.rejected.map((d) => DOC_LABELS[d]).join(', ')}</p>`
      : ''}
    <div style="margin-top:10px">${rows}</div>
  </div>`;
}

/* ---------------------------------------------------------------- upload --- */

post('/applications/:id/documents', async (ctx) => {
  const app = await loadApp(ctx, ctx.params.id);
  if (!app) return errorPage(ctx, 404, 'Application not found.');
  const back = `/applications/${app.id}`;

  const form = await ctx.req.formData();
  const docType = String(form.get('doc_type') ?? '') as DocType;
  if (!DOC_TYPES.includes(docType)) return flash(back, 'err', 'Unknown document type.');

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return flash(back, 'err', 'Choose a file to upload.');

  const maxBytes = num(ctx.settings, 'max_file_bytes', 10 * 1024 * 1024);
  if (file.size > maxBytes) {
    return flash(back, 'err', `File is ${humanSize(file.size)}; the limit is ${humanSize(maxBytes)}.`);
  }

  const buf = await file.arrayBuffer();
  // Declared type is not trusted: the first bytes decide (§6.2).
  const actual = sniff(new Uint8Array(buf.slice(0, 16)));
  if (!actual) return flash(back, 'err', 'Only PDF, JPG and PNG files are accepted. This file is neither.');

  const digest = await sha256Hex(buf);
  // Storage key is generated, never derived from the user's file name.
  const key = `applications/${app.id}/${docType}/${randomId('')}.${ALLOWED[actual].ext}`;
  await ctx.env.DOCS.put(key, buf, { httpMetadata: { contentType: actual } });

  const prev = await ctx.env.DB.prepare(
    'SELECT * FROM application_documents WHERE application_id = ? AND doc_type = ? AND is_current = 1',
  ).bind(app.id, docType).first<{ id: string; version: number; status: string; original_name: string }>();

  if (prev) {
    await ctx.env.DB.prepare('UPDATE application_documents SET is_current = 0 WHERE id = ?').bind(prev.id).run();
  }

  const id = randomId('doc_');
  await ctx.env.DB.prepare(
    `INSERT INTO application_documents (id, application_id, doc_type, status, storage_key, original_name,
       mime_type, size_bytes, sha256, version, is_current, uploaded_by)
     VALUES (?,?,?,'uploaded',?,?,?,?,?,?,1,?)`,
  ).bind(id, app.id, docType, key, file.name.slice(0, 200), actual, file.size, digest,
    (prev?.version ?? 0) + 1, ctx.user!.id).run();

  await ctx.env.DB.prepare(
    'INSERT INTO document_events (id, document_id, action, actor, before_json, after_json) VALUES (?,?,?,?,?,?)',
  ).bind(randomId('de_'), id, prev ? 'replace' : 'upload', ctx.user!.id,
    prev ? JSON.stringify({ version: prev.version, status: prev.status }) : null,
    JSON.stringify({ version: (prev?.version ?? 0) + 1, size: file.size, sha256: digest })).run();

  await audit(ctx, prev ? 'document.replace' : 'document.upload', 'application_documents', id,
    prev ? { doc_type: docType, version: prev.version } : undefined,
    { doc_type: docType, size: file.size, sha256: digest });

  await syncDocState(ctx, app.id);
  return flash(back, 'ok', `${DOC_LABELS[docType]} ${prev ? 'replaced' : 'uploaded'}. It still needs verification.`);
}, { cap: 'upload_documents' });

/* -------------------------------------------------------------- download --- */

/** Authorised on the server every time; R2 objects are never public (§6.2). */
get('/documents/:id/download', async (ctx) => {
  const scope = visibilityScope(ctx);
  const doc = await ctx.env.DB.prepare(
    `SELECT d.* FROM application_documents d JOIN applications a ON a.id = d.application_id
      WHERE d.id = ? AND ${scope.sql}`,
  ).bind(ctx.params.id, ...scope.binds).first<{ id: string; storage_key: string; mime_type: string; original_name: string }>();
  if (!doc) return errorPage(ctx, 404, 'Document not found, or not visible to your account.');

  const obj = await ctx.env.DOCS.get(doc.storage_key);
  if (!obj) return errorPage(ctx, 404, 'The stored file is missing. Report this to an administrator.');

  await audit(ctx, 'document.download', 'application_documents', doc.id);
  // File name is sanitised before it reaches a response header.
  const safe = doc.original_name.replace(/[^\w.\- ]/g, '_');
  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mime_type,
      'Content-Disposition': `inline; filename="${safe}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}, { cap: 'view_records' });

/* ---------------------------------------------------- verify / reject --- */

async function docWithApp(ctx: Ctx, id: string) {
  const scope = visibilityScope(ctx);
  return ctx.env.DB.prepare(
    `SELECT d.*, a.id AS app_id FROM application_documents d JOIN applications a ON a.id = d.application_id
      WHERE d.id = ? AND d.is_current = 1 AND ${scope.sql}`,
  ).bind(id, ...scope.binds).first<{ id: string; app_id: string; doc_type: DocType; status: string; storage_key: string }>();
}

post('/documents/:id/verify', async (ctx) => {
  const doc = await docWithApp(ctx, ctx.params.id);
  if (!doc) return errorPage(ctx, 404, 'Document not found.');
  await ctx.env.DB.prepare(
    "UPDATE application_documents SET status='verified', verified_by=?, verified_at=datetime('now'), notes=NULL WHERE id=?",
  ).bind(ctx.user!.id, doc.id).run();
  await ctx.env.DB.prepare(
    "INSERT INTO document_events (id, document_id, action, actor, before_json, after_json) VALUES (?,?,'verify',?,?,?)",
  ).bind(randomId('de_'), doc.id, ctx.user!.id, JSON.stringify({ status: doc.status }), JSON.stringify({ status: 'verified' })).run();
  await audit(ctx, 'document.verify', 'application_documents', doc.id, { status: doc.status }, { status: 'verified' });
  await syncDocState(ctx, doc.app_id);
  return flash(`/applications/${doc.app_id}`, 'ok', `${DOC_LABELS[doc.doc_type]} verified.`);
}, { cap: 'verify_documents' });

post('/documents/:id/reject', async (ctx) => {
  const doc = await docWithApp(ctx, ctx.params.id);
  if (!doc) return errorPage(ctx, 404, 'Document not found.');
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const notes = String(form.notes ?? '').trim().slice(0, 300);
  if (!notes) return flash(`/applications/${doc.app_id}`, 'err', 'A rejection reason is required.');

  await ctx.env.DB.prepare(
    "UPDATE application_documents SET status='rejected', verified_by=?, verified_at=datetime('now'), notes=? WHERE id=?",
  ).bind(ctx.user!.id, notes, doc.id).run();
  await ctx.env.DB.prepare(
    "INSERT INTO document_events (id, document_id, action, actor, before_json, after_json) VALUES (?,?,'reject',?,?,?)",
  ).bind(randomId('de_'), doc.id, ctx.user!.id, JSON.stringify({ status: doc.status }), JSON.stringify({ status: 'rejected', notes })).run();
  await audit(ctx, 'document.reject', 'application_documents', doc.id, { status: doc.status }, { status: 'rejected' });
  await syncDocState(ctx, doc.app_id);
  return flash(`/applications/${doc.app_id}`, 'ok', `${DOC_LABELS[doc.doc_type]} rejected. It no longer counts as verified.`);
}, { cap: 'verify_documents' });

post('/documents/:id/remove', async (ctx) => {
  const doc = await docWithApp(ctx, ctx.params.id);
  if (!doc) return errorPage(ctx, 404, 'Document not found.');
  await ctx.env.DOCS.delete(doc.storage_key);
  await ctx.env.DB.prepare("UPDATE application_documents SET status='removed', is_current=0 WHERE id=?").bind(doc.id).run();
  await ctx.env.DB.prepare(
    "INSERT INTO document_events (id, document_id, action, actor, before_json, after_json) VALUES (?,?,'remove',?,?,?)",
  ).bind(randomId('de_'), doc.id, ctx.user!.id, JSON.stringify({ status: doc.status }), JSON.stringify({ status: 'removed' })).run();
  await audit(ctx, 'document.remove', 'application_documents', doc.id, { status: doc.status }, { status: 'removed' });
  await syncDocState(ctx, doc.app_id);
  return flash(`/applications/${doc.app_id}`, 'ok', `${DOC_LABELS[doc.doc_type]} removed.`);
}, { cap: 'upload_documents' });

/* ---------------------------------------------------- verification queue --- */

get('/verification', async (ctx) => {
  const scope = visibilityScope(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT a.id, a.application_no, a.customer_name, a.category, a.status, a.doc_overall_status,
            a.updated_at, i.name AS insurer_name,
            (SELECT COUNT(*) FROM application_documents d
              WHERE d.application_id = a.id AND d.is_current = 1 AND d.status IN ('uploaded','pending_verification')) AS awaiting,
            (SELECT COUNT(*) FROM application_documents d
              WHERE d.application_id = a.id AND d.is_current = 1 AND d.status = 'rejected') AS rejected
       FROM applications a LEFT JOIN insurers i ON i.id = a.insurer_id
      WHERE ${scope.sql} AND a.status NOT IN ('rejected','cancelled')
        AND a.doc_overall_status IN ('incomplete','partial','pending_verification','rejected')
      ORDER BY (a.doc_overall_status = 'pending_verification') DESC, a.updated_at DESC
      LIMIT 200`,
  ).bind(...scope.binds).all<{ id: string; application_no: string; customer_name: string; category: string; status: string; doc_overall_status: string; updated_at: string; insurer_name: string | null; awaiting: number; rejected: number }>();

  const rows = results.map((r) => html`<tr>
    <td><a href="/applications/${r.id}">${r.application_no}</a></td>
    <td>${r.customer_name}</td>
    <td>${badge(r.category)}</td>
    <td>${r.insurer_name ?? '—'}</td>
    <td>${badge(r.doc_overall_status)}</td>
    <td class="num">${r.awaiting}</td>
    <td class="num">${r.rejected}</td>
    <td>${badge(r.status)}</td>
    <td>${r.updated_at}</td>
  </tr>`);

  return page(
    { title: 'Verification queue', user: ctx.user, ctx, active: '/verification', wide: true },
    html`<div class="pagehead"><div><h1>Document Verification Queue</h1>
      <p>Applications whose documents are incomplete, awaiting verification or rejected.</p></div></div>
    ${flashFromUrl(ctx.url)}
    ${table(['Application No', 'Customer', 'Category', 'Insurer', 'Documents', numh('Awaiting'), numh('Rejected'), 'Policy status', 'Updated'],
      rows, 'Nothing is waiting on documents.')}`,
  );
}, { cap: 'view_records' });
