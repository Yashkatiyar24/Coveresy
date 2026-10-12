import type { AppStatus, Role } from './types.ts';
import type { DocAssessment } from './rules.ts';

export interface TransitionContext {
  role: Role;
  docs: DocAssessment;
  app: { policy_no: string | null; issued_date: string | null; customer_name: string; application_no: string; premium_paise: number };
  remark: string;
  operatorsMayVerify: boolean;
}

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * §14.3. The server is the only authority here — the UI hides buttons as a
 * convenience, this function is what actually blocks a transition, including
 * one posted straight at the API.
 */
export function checkTransition(
  from: AppStatus,
  to: AppStatus,
  c: TransitionContext,
): TransitionCheck {
  const isAdmin = c.role === 'admin';
  const isOperator = c.role === 'operator';
  const staff = isAdmin || isOperator;

  // Admin may reject or cancel from any open status, with a reason.
  if (to === 'rejected' || to === 'cancelled') {
    if (!isAdmin) return { allowed: false, reason: 'Only an Admin may reject or cancel.' };
    if (!c.remark.trim()) return { allowed: false, reason: 'A reason is required to reject or cancel.' };
    if (from === 'rejected' || from === 'cancelled') {
      return { allowed: false, reason: 'This application is already closed.' };
    }
    return { allowed: true };
  }

  switch (`${from}->${to}`) {
    case 'draft->application_logged': {
      if (!staff) return { allowed: false, reason: 'Only Admin or Operator may log an application.' };
      const missing: string[] = [];
      if (!c.app.customer_name?.trim()) missing.push('Customer Name');
      if (!c.app.application_no?.trim()) missing.push('Application Number');
      if (!(c.app.premium_paise > 0)) missing.push('Premium Amount');
      return missing.length
        ? { allowed: false, reason: `Required MIS fields missing: ${missing.join(', ')}.` }
        : { allowed: true };
    }

    case 'application_logged->documents_pending':
      return c.docs.complete
        ? { allowed: false, reason: 'All mandatory documents are already uploaded.' }
        : { allowed: true };

    case 'application_logged->documents_uploaded':
    case 'documents_pending->documents_uploaded':
      return c.docs.complete
        ? { allowed: true }
        : { allowed: false, reason: `Mandatory documents still missing: ${c.docs.missing.join(', ')}.` };

    case 'documents_uploaded->pending_verification':
      return c.docs.complete
        ? { allowed: true }
        : { allowed: false, reason: 'All mandatory documents must be uploaded first.' };

    case 'pending_verification->verified': {
      if (!(isAdmin || (isOperator && c.operatorsMayVerify))) {
        return { allowed: false, reason: 'You are not an approved verifier.' };
      }
      if (c.docs.rejected.length) {
        return { allowed: false, reason: `Rejected documents must be resolved: ${c.docs.rejected.join(', ')}.` };
      }
      return c.docs.verified
        ? { allowed: true }
        : { allowed: false, reason: `Not all mandatory documents are verified: ${c.docs.awaitingVerification.join(', ')}.` };
    }

    case 'verified->submitted_to_insurer':
      if (!staff) return { allowed: false, reason: 'Only Admin or Operator may submit to the insurer.' };
      return c.docs.verified
        ? { allowed: true }
        : { allowed: false, reason: 'Document verification no longer holds; re-verify before submitting.' };

    case 'submitted_to_insurer->policy_issued': {
      if (!staff) return { allowed: false, reason: 'Only Admin or Operator may mark a policy issued.' };
      const missing: string[] = [];
      if (!c.app.policy_no?.trim()) missing.push('Policy Number');
      if (!c.app.issued_date?.trim()) missing.push('Policy Issued Date');
      return missing.length
        ? { allowed: false, reason: `Enter ${missing.join(' and ')} before marking the policy issued.` }
        : { allowed: true };
    }

    // Documents going stale sends an application back for more documents.
    case 'documents_uploaded->documents_pending':
    case 'pending_verification->documents_pending':
    case 'verified->pending_verification':
      return staff ? { allowed: true } : { allowed: false, reason: 'Not permitted for your role.' };

    default:
      return { allowed: false, reason: `Transition ${from} → ${to} is not permitted.` };
  }
}

/** Target statuses worth offering in the UI for a given current status. */
export function nextStatuses(from: AppStatus): AppStatus[] {
  const map: Partial<Record<AppStatus, AppStatus[]>> = {
    draft: ['application_logged'],
    application_logged: ['documents_pending', 'documents_uploaded'],
    documents_pending: ['documents_uploaded'],
    documents_uploaded: ['pending_verification', 'documents_pending'],
    pending_verification: ['verified', 'documents_pending'],
    verified: ['submitted_to_insurer', 'pending_verification'],
    submitted_to_insurer: ['policy_issued'],
  };
  return [...(map[from] ?? []), ...(from === 'rejected' || from === 'cancelled' ? [] : ['rejected' as AppStatus, 'cancelled' as AppStatus])];
}
