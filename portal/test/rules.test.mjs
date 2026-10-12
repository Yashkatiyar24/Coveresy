// §20 acceptance tests for the two pieces of real business logic.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDocuments, overallStatus } from '../src/rules.ts';
import { computePayout, selectRule, paise, rupees, pctToBp, bpToPct } from '../src/payout.ts';
import { checkTransition } from '../src/transitions.ts';

const RULES = [
  { category: 'health', doc_type: 'policy_copy', requirement: 'mandatory' },
  { category: 'health', doc_type: 'proposal_form', requirement: 'mandatory' },
  { category: 'health', doc_type: 'payment_receipt', requirement: 'mandatory' },
  { category: 'life', doc_type: 'policy_copy', requirement: 'optional' },
  { category: 'life', doc_type: 'proposal_form', requirement: 'mandatory' },
  { category: 'life', doc_type: 'payment_receipt', requirement: 'mandatory' },
];
const v = (t) => ({ doc_type: t, status: 'verified' });
const up = (t) => ({ doc_type: t, status: 'uploaded' });
const rej = (t) => ({ doc_type: t, status: 'rejected' });
const ALL = ['policy_copy', 'proposal_form', 'payment_receipt'];

/* ------------------------------------------------------- document rules --- */

test('health without Policy Copy cannot be completed or verified', () => {
  const a = assessDocuments('health', RULES, [v('proposal_form'), v('payment_receipt')]);
  assert.equal(a.complete, false);
  assert.equal(a.verified, false);
  assert.deepEqual(a.missing, ['policy_copy']);
});

test('health without Proposal Form cannot be completed or verified', () => {
  const a = assessDocuments('health', RULES, [v('policy_copy'), v('payment_receipt')]);
  assert.equal(a.complete, false);
  assert.equal(a.verified, false);
  assert.deepEqual(a.missing, ['proposal_form']);
});

test('health without Payment Receipt cannot be completed or verified', () => {
  const a = assessDocuments('health', RULES, [v('policy_copy'), v('proposal_form')]);
  assert.equal(a.complete, false);
  assert.equal(a.verified, false);
  assert.deepEqual(a.missing, ['payment_receipt']);
});

test('health with all three verified is complete and verified', () => {
  const a = assessDocuments('health', RULES, ALL.map(v));
  assert.equal(a.complete, true);
  assert.equal(a.verified, true);
  assert.equal(a.summary, '3 of 3 required documents uploaded');
  assert.equal(overallStatus(a), 'verified');
});

test('life WITHOUT Policy Copy proceeds when the other two are valid', () => {
  const a = assessDocuments('life', RULES, [v('proposal_form'), v('payment_receipt')]);
  assert.equal(a.complete, true);
  assert.equal(a.verified, true);
  assert.deepEqual(a.missing, []);
  assert.equal(a.requiredTotal, 2);
});

test('life without Proposal Form cannot be completed or verified', () => {
  const a = assessDocuments('life', RULES, [v('policy_copy'), v('payment_receipt')]);
  assert.equal(a.complete, false);
  assert.equal(a.verified, false);
});

test('life without Payment Receipt cannot be completed or verified', () => {
  const a = assessDocuments('life', RULES, [v('policy_copy'), v('proposal_form')]);
  assert.equal(a.complete, false);
  assert.equal(a.verified, false);
});

test('a rejected mandatory document never counts as verified', () => {
  const a = assessDocuments('health', RULES, [rej('policy_copy'), v('proposal_form'), v('payment_receipt')]);
  assert.equal(a.verified, false);
  assert.equal(a.complete, false, 'a rejected file is not a usable file');
  assert.deepEqual(a.rejected, ['policy_copy']);
  assert.equal(overallStatus(a), 'rejected');
});

test('a rejected OPTIONAL document still blocks verification ("none Rejected")', () => {
  const a = assessDocuments('life', RULES, [rej('policy_copy'), v('proposal_form'), v('payment_receipt')]);
  assert.equal(a.complete, true, 'mandatory set is satisfied');
  assert.equal(a.verified, false, 'but something is rejected');
});

test('an absent optional document never blocks completion', () => {
  const a = assessDocuments('life', RULES, [v('proposal_form'), v('payment_receipt')]);
  assert.equal(a.complete, true);
  assert.equal(a.verified, true);
});

test('uploaded-but-unverified is reported separately from missing', () => {
  const a = assessDocuments('health', RULES, [up('policy_copy'), v('proposal_form')]);
  assert.deepEqual(a.missing, ['payment_receipt']);
  assert.deepEqual(a.awaitingVerification, ['policy_copy']);
  assert.equal(a.verified, false);
  assert.equal(overallStatus(a), 'partial');
});

test('switching Life to Health immediately triggers Health validation', () => {
  const docs = [v('proposal_form'), v('payment_receipt')]; // no Policy Copy
  assert.equal(assessDocuments('life', RULES, docs).verified, true);
  assert.equal(assessDocuments('health', RULES, docs).verified, false,
    'the same attachments must fail once the category is Health');
  assert.deepEqual(assessDocuments('health', RULES, docs).missing, ['policy_copy']);
});

test('a removed document does not count as present', () => {
  const a = assessDocuments('health', RULES, [...ALL.map(v).slice(1), { doc_type: 'policy_copy', status: 'removed' }]);
  assert.deepEqual(a.missing, ['policy_copy']);
});

test('rules are data: making Health Policy Copy optional changes the outcome', () => {
  const relaxed = RULES.map((r) =>
    r.category === 'health' && r.doc_type === 'policy_copy' ? { ...r, requirement: 'optional' } : r);
  const docs = [v('proposal_form'), v('payment_receipt')];
  assert.equal(assessDocuments('health', RULES, docs).complete, false);
  assert.equal(assessDocuments('health', relaxed, docs).complete, true);
});

/* ------------------------------------------------------------ transitions --- */

const baseApp = { policy_no: null, issued_date: null, customer_name: 'A', application_no: 'X1', premium_paise: 100 };
const ctx = (over = {}) => ({
  role: 'admin', remark: '', operatorsMayVerify: false, app: baseApp,
  docs: assessDocuments('health', RULES, ALL.map(v)), ...over,
});

test('direct API call cannot verify while a mandatory document is missing', () => {
  const r = checkTransition('pending_verification', 'verified',
    ctx({ docs: assessDocuments('health', RULES, [v('proposal_form'), v('payment_receipt')]) }));
  assert.equal(r.allowed, false);
});

test('direct API call cannot verify while a document is rejected', () => {
  const r = checkTransition('pending_verification', 'verified',
    ctx({ docs: assessDocuments('health', RULES, [rej('policy_copy'), v('proposal_form'), v('payment_receipt')]) }));
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Rejected/);
});

test('an operator cannot verify unless the setting allows it', () => {
  assert.equal(checkTransition('pending_verification', 'verified', ctx({ role: 'operator' })).allowed, false);
  assert.equal(checkTransition('pending_verification', 'verified',
    ctx({ role: 'operator', operatorsMayVerify: true })).allowed, true);
});

test('a viewer cannot move anything', () => {
  assert.equal(checkTransition('draft', 'application_logged', ctx({ role: 'viewer' })).allowed, false);
  assert.equal(checkTransition('verified', 'submitted_to_insurer', ctx({ role: 'viewer' })).allowed, false);
});

test('policy issued requires a policy number and issued date', () => {
  assert.equal(checkTransition('submitted_to_insurer', 'policy_issued', ctx()).allowed, false);
  assert.equal(checkTransition('submitted_to_insurer', 'policy_issued',
    ctx({ app: { ...baseApp, policy_no: 'P1', issued_date: '2026-10-01' } })).allowed, true);
});

test('only an Admin may cancel, and only with a reason', () => {
  assert.equal(checkTransition('verified', 'cancelled', ctx({ role: 'operator', remark: 'x' })).allowed, false);
  assert.equal(checkTransition('verified', 'cancelled', ctx({ remark: '' })).allowed, false);
  assert.equal(checkTransition('verified', 'cancelled', ctx({ remark: 'customer withdrew' })).allowed, true);
});

test('uploading documents never implies a policy is issued', () => {
  assert.equal(checkTransition('documents_uploaded', 'policy_issued', ctx()).allowed, false);
  assert.equal(checkTransition('verified', 'policy_issued', ctx()).allowed, false);
});

test('draft cannot be logged without the required MIS fields', () => {
  const r = checkTransition('draft', 'application_logged', ctx({ app: { ...baseApp, premium_paise: 0 } }));
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Premium/);
});

/* ---------------------------------------------------------------- payouts --- */

test('gross, TDS and net follow the approved formulas', () => {
  // 50,000.00 premium, 12.5% payout, 5% TDS, 100.00 deduction
  const r = computePayout({ basePaise: 5_000_000, payoutBp: 1250, tdsBp: 500, deductionsPaise: 10_000 });
  assert.equal(r.grossPaise, 625_000);   // 6,250.00
  assert.equal(r.tdsPaise, 31_250);      //   312.50
  assert.equal(r.netPaise, 583_750);     // 5,837.50
});

test('rounding is half-up at the paise and never drifts', () => {
  // 1 paise base at 50% -> 0.5 paise -> rounds up to 1
  assert.equal(computePayout({ basePaise: 1, payoutBp: 5000, tdsBp: 0, deductionsPaise: 0 }).grossPaise, 1);
  // 1 paise at 49% -> 0.49 -> rounds down to 0
  assert.equal(computePayout({ basePaise: 1, payoutBp: 4900, tdsBp: 0, deductionsPaise: 0 }).grossPaise, 0);
  // 333.33 at 3.33%
  const r = computePayout({ basePaise: 33_333, payoutBp: 333, tdsBp: 0, deductionsPaise: 0 });
  assert.equal(r.grossPaise, 1110); // 1109.98... -> 1110
});

test('a zero payout percentage yields zero, not a crash', () => {
  const r = computePayout({ basePaise: 5_000_000, payoutBp: 0, tdsBp: 500, deductionsPaise: 0 });
  assert.equal(r.grossPaise, 0);
  assert.equal(r.netPaise, 0);
});

test('negative inputs are refused rather than silently computed', () => {
  assert.throws(() => computePayout({ basePaise: -1, payoutBp: 100, tdsBp: 0, deductionsPaise: 0 }));
  assert.throws(() => computePayout({ basePaise: 1, payoutBp: -100, tdsBp: 0, deductionsPaise: 0 }));
});

test('TDS is not assumed to be 2% — it comes from the rule', () => {
  const at2 = computePayout({ basePaise: 1_000_000, payoutBp: 1000, tdsBp: 200, deductionsPaise: 0 });
  const at5 = computePayout({ basePaise: 1_000_000, payoutBp: 1000, tdsBp: 500, deductionsPaise: 0 });
  assert.notEqual(at2.tdsPaise, at5.tdsPaise);
  assert.equal(at2.tdsPaise, 2000);
  assert.equal(at5.tdsPaise, 5000);
});

test('most specific payout rule wins, and dates are respected', () => {
  const mk = (o) => ({ id: o.id, insurer_id: null, product_id: null, partner_id: null,
    base_type: 'premium', payout_bp: o.bp, tds_bp: 500,
    effective_from: o.from ?? '2020-01-01', effective_to: o.to ?? null, ...o });
  const rules = [
    mk({ id: 'any', bp: 500 }),
    mk({ id: 'insurer', bp: 800, insurer_id: 'i1' }),
    mk({ id: 'insurer+product', bp: 1000, insurer_id: 'i1', product_id: 'p1' }),
    mk({ id: 'partner', bp: 1500, partner_id: 'pa1' }),
    mk({ id: 'expired', bp: 9900, insurer_id: 'i1', product_id: 'p1', partner_id: 'pa1', to: '2024-12-31' }),
  ];
  const app = { insurer_id: 'i1', product_id: 'p1', partner_id: 'pa1' };
  assert.equal(selectRule(rules, app, '2026-06-01').id, 'partner', 'partner is the most specific live rule');
  assert.equal(selectRule(rules, app, '2024-06-01').id, 'expired', 'the fully specific rule applies while live');
  assert.equal(selectRule(rules, { insurer_id: 'i9', product_id: null, partner_id: null }, '2026-06-01').id, 'any');
  assert.equal(selectRule([], app, '2026-06-01'), null);
});

test('a rule naming a different insurer never applies', () => {
  const rules = [{ id: 'other', insurer_id: 'i2', product_id: null, partner_id: null,
    base_type: 'premium', payout_bp: 9999, tds_bp: 0, effective_from: '2020-01-01', effective_to: null }];
  assert.equal(selectRule(rules, { insurer_id: 'i1', product_id: null, partner_id: null }, '2026-06-01'), null);
});

test('rupee parsing and formatting round-trip without float drift', () => {
  assert.equal(paise('1234.56'), 123456);
  assert.equal(paise('0.07'), 7);
  assert.equal(paise('1,00,000'), 10000000);
  assert.equal(paise(''), 0);
  assert.equal(rupees(123456), '1,234.56');
  assert.equal(rupees(7), '0.07');
  assert.throws(() => paise('12.345'), /invalid amount/);
  assert.throws(() => paise('abc'), /invalid amount/);
  for (const s of ['0.01', '99.99', '100000.00', '7.70']) {
    assert.equal(rupees(paise(s)).replace(/,/g, ''), s);
  }
});

test('percentages convert to basis points exactly', () => {
  assert.equal(pctToBp('12.5'), 1250);
  assert.equal(pctToBp('5'), 500);
  assert.equal(pctToBp('0.01'), 1);
  assert.equal(bpToPct(1250), '12.50');
  assert.throws(() => pctToBp('1.234'), /invalid percentage/);
});
