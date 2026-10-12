import type { Category, DocType } from './types.ts';
import { DOC_TYPES } from './types.ts';

export interface DocRule {
  category: Category;
  doc_type: DocType;
  requirement: 'mandatory' | 'optional';
}

export interface DocRecord {
  doc_type: DocType;
  /** Status of the CURRENT version only. Superseded versions are not passed in. */
  status: 'uploaded' | 'pending_verification' | 'verified' | 'rejected' | 'removed';
}

export interface DocAssessment {
  required: DocType[];
  optional: DocType[];
  /** Mandatory docs with no usable file at all. */
  missing: DocType[];
  /** Uploaded but not yet verified — shown separately from missing (§6.1). */
  awaitingVerification: DocType[];
  /** Any current document in rejected state, mandatory or optional. */
  rejected: DocType[];
  requiredUploaded: number;
  requiredTotal: number;
  /** All mandatory documents have a usable (non-rejected) file. */
  complete: boolean;
  /** All mandatory verified AND nothing rejected. */
  verified: boolean;
  summary: string;
}

/**
 * The §3 rule engine. Rules come from the document_rules table, never from
 * constants here, so Admin can change them without a deploy. Anything not
 * covered by a rule row is treated as optional.
 */
export function assessDocuments(
  category: Category,
  rules: DocRule[],
  docs: DocRecord[],
): DocAssessment {
  const forCategory = new Map<DocType, 'mandatory' | 'optional'>();
  for (const r of rules) if (r.category === category) forCategory.set(r.doc_type, r.requirement);

  const required = DOC_TYPES.filter((d) => forCategory.get(d) === 'mandatory');
  const optional = DOC_TYPES.filter((d) => forCategory.get(d) !== 'mandatory');

  const current = new Map<DocType, DocRecord['status']>();
  for (const d of docs) if (d.status !== 'removed') current.set(d.doc_type, d.status);

  const usable = (d: DocType) => {
    const s = current.get(d);
    return s !== undefined && s !== 'rejected';
  };
  const isVerified = (d: DocType) => current.get(d) === 'verified';

  const missing = required.filter((d) => !usable(d));
  const awaitingVerification = required.filter((d) => usable(d) && !isVerified(d));
  const rejected = DOC_TYPES.filter((d) => current.get(d) === 'rejected');

  const requiredUploaded = required.length - missing.length;
  const complete = missing.length === 0;
  // "none Rejected" (§14.3) is read literally: a rejected optional document
  // blocks verification too, because it needs resolving either way.
  const verified = complete && required.every(isVerified) && rejected.length === 0;

  return {
    required,
    optional,
    missing,
    awaitingVerification,
    rejected,
    requiredUploaded,
    requiredTotal: required.length,
    complete,
    verified,
    summary: `${requiredUploaded} of ${required.length} required documents uploaded`,
  };
}

/** Value written to applications.doc_overall_status. */
export function overallStatus(a: DocAssessment): string {
  if (a.rejected.length) return 'rejected';
  if (a.verified) return 'verified';
  if (a.complete) return 'pending_verification';
  if (a.requiredUploaded > 0) return 'partial';
  return 'incomplete';
}
