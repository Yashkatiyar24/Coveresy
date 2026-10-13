export interface Env {
  DB: D1Database;
  /** Absent until R2 is enabled on the account; document routes check first. */
  DOCS?: R2Bucket;
  /** Missing-policy attachments. KV, because R2 needs a card on file. */
  DOCS_KV?: KVNamespace;
  COVERESY_ENV?: string;
  COVERESY_SESSION_SECRET?: string;
  COVERESY_SETUP_TOKEN?: string;
  /** Mount path when served under a subpath, e.g. "/admin". Empty = root. */
  BASE_PATH?: string;
  /**
   * Comma-separated public hostnames this Worker is served under when it sits
   * behind a reverse proxy. The proxy forwards the browser's Origin, but the
   * Worker's own req.url carries the origin host, so the CSRF check needs to
   * know which public hosts are legitimately ours.
   */
  ALLOWED_ORIGINS?: string;
  /** Shared bearer secret the public partner API presents to the sink route. */
  PARTNER_SINK_SECRET?: string;
}

export type Role = 'admin' | 'operator' | 'viewer';
export type Category = 'health' | 'life';
export type DocType = 'policy_copy' | 'proposal_form' | 'payment_receipt';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
}

/** Everything a request handler is given. */
export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  user: User | null;
  params: Record<string, string>;
  settings: Record<string, string>;
  ip: string;
}

export const DOC_TYPES: DocType[] = ['policy_copy', 'proposal_form', 'payment_receipt'];

export const DOC_LABELS: Record<DocType, string> = {
  policy_copy: 'Policy Copy',
  proposal_form: 'Proposal Form',
  payment_receipt: 'Payment Receipt',
};

export const APP_STATUSES = [
  'draft',
  'application_logged',
  'documents_pending',
  'documents_uploaded',
  'pending_verification',
  'verified',
  'submitted_to_insurer',
  'policy_issued',
  'rejected',
  'cancelled',
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const PAYOUT_STATUSES = [
  'not_initiated',
  'pending',
  'approved',
  'processing',
  'paid',
  'on_hold',
  'reversed',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Statuses from which Admin may always reject/cancel (section 14.3). */
export const OPEN_STATUSES: AppStatus[] = [
  'draft',
  'application_logged',
  'documents_pending',
  'documents_uploaded',
  'pending_verification',
  'verified',
  'submitted_to_insurer',
];

export function label(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
