/**
 * Money is integer paise throughout; percentages are integer basis points.
 * Nothing here ever sees a float, so no cumulative rounding drift.
 */

export interface PayoutRule {
  id: string;
  insurer_id: string | null;
  product_id: string | null;
  partner_id: string | null;
  base_type: 'premium' | 'net_premium';
  payout_bp: number;
  tds_bp: number;
  effective_from: string;
  effective_to: string | null;
}

export interface PayoutInput {
  basePaise: number;
  payoutBp: number;
  tdsBp: number;
  deductionsPaise: number;
}

export interface PayoutResult {
  basePaise: number;
  grossPaise: number;
  tdsPaise: number;
  deductionsPaise: number;
  netPaise: number;
}

/** Half-up rounding on a non-negative integer division. */
function applyBp(paise: number, bp: number): number {
  return Math.floor((paise * bp + 5000) / 10000);
}

export function computePayout(i: PayoutInput): PayoutResult {
  if (i.basePaise < 0 || i.payoutBp < 0 || i.tdsBp < 0 || i.deductionsPaise < 0) {
    throw new Error('payout inputs must be non-negative');
  }
  const grossPaise = applyBp(i.basePaise, i.payoutBp);
  // §18 decision 2: TDS is applied on gross payout by default.
  const tdsPaise = applyBp(grossPaise, i.tdsBp);
  const netPaise = grossPaise - tdsPaise - i.deductionsPaise;
  return {
    basePaise: i.basePaise,
    grossPaise,
    tdsPaise,
    deductionsPaise: i.deductionsPaise,
    netPaise,
  };
}

/**
 * §18 decision 4: insurer + product + partner, most specific rule wins,
 * date-effective. A rule with a NULL column is a wildcard; a rule naming a
 * different value than the application does not apply at all.
 */
export function selectRule(
  rules: PayoutRule[],
  app: { insurer_id: string; product_id: string | null; partner_id: string | null },
  onDate: string,
): PayoutRule | null {
  const matches = (ruleVal: string | null, appVal: string | null) =>
    ruleVal === null || ruleVal === appVal;

  const applicable = rules.filter(
    (r) =>
      matches(r.insurer_id, app.insurer_id) &&
      matches(r.product_id, app.product_id) &&
      matches(r.partner_id, app.partner_id) &&
      r.effective_from <= onDate &&
      (r.effective_to === null || r.effective_to >= onDate),
  );
  if (!applicable.length) return null;

  const specificity = (r: PayoutRule) =>
    (r.partner_id ? 4 : 0) + (r.product_id ? 2 : 0) + (r.insurer_id ? 1 : 0);

  return applicable.sort(
    (a, b) =>
      specificity(b) - specificity(a) ||
      b.effective_from.localeCompare(a.effective_from),
  )[0];
}

/**
 * Marks a cell as money for exports: it prints as "5937.50" in CSV but is
 * written as the number 5937.5 in XLSX, so Excel can total the column.
 */
export class Money {
  readonly paise: number;
  constructor(paise: number) { this.paise = paise; }
  get rupees(): number { return this.paise / 100; }
  toString(): string { return (this.paise / 100).toFixed(2); }
}

/* ------------------------------------------------------ display helpers --- */

export function paise(rupeesInput: string | number): number {
  const s = String(rupeesInput).trim().replace(/,/g, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid amount: ${rupeesInput}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function rupees(p: number): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}

export function bpToPct(bp: number): string {
  return (bp / 100).toFixed(2);
}

export function pctToBp(pctInput: string | number): number {
  const s = String(pctInput).trim();
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid percentage: ${pctInput}`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
