import type { TaxYearParams } from "../model/types";
import { computeCGT } from "./cgt";
import { computeIncomeTax, type IncomeTaxAdjustment } from "./incomeTax";

/** One person's taxable income and gains for one tax year. */
export interface YearIncome {
  /** Pension drawdown (taxable part), State Pension, earnings. */
  nonSavings: number;
  /** Cash interest and gilt coupons. */
  savings: number;
  dividends: number;
  /** Realised GIA gains (gilts are CGT-exempt and never included). */
  gain: number;
}

/** The marriage allowance: 10% of the personal allowance, rounded up to the next £10
 *  (£1,260 for 2025/26), worth `basicRate` × that to the recipient. */
export function marriageAllowance(p: TaxYearParams): number {
  return Math.ceil((p.personalAllowance * 0.1) / 10) * 10;
}

/**
 * Income tax + CGT for a married couple's year, applying the marriage allowance when they are
 * eligible and it saves the household tax: one partner transfers 10% of their personal
 * allowance and the other gets a basic-rate tax reducer for it. Both must be within the basic
 * rate (neither liable at the higher or additional rate), checked on their own incomes.
 */
export function coupleYearTax(
  a: YearIncome,
  b: YearIncome,
  p: TaxYearParams,
  married: boolean,
): { a: PersonYearTax; b: PersonYearTax } {
  const base = { a: personYearTax(a, p), b: personYearTax(b, p) };
  if (!married) return base;
  const eligible = base.a.taxableTotal <= p.basicRateBand && base.b.taxableTotal <= p.basicRateBand;
  if (!eligible) return base;
  const ma = marriageAllowance(p);
  const reducer = { taxReducer: p.basicRate * ma };
  const giveAB = { a: personYearTax(a, p, { paReduction: ma }), b: personYearTax(b, p, reducer) };
  const giveBA = { a: personYearTax(a, p, reducer), b: personYearTax(b, p, { paReduction: ma }) };
  const total = (t: { a: PersonYearTax; b: PersonYearTax }) => t.a.total + t.b.total;
  let best = base;
  for (const option of [giveAB, giveBA]) if (total(option) < total(best) - 0.005) best = option;
  return best;
}

export interface PersonYearTax {
  incomeTax: number;
  cgt: number;
  total: number;
  /** Taxable income after the personal allowance. */
  taxableTotal: number;
}

/**
 * Income tax + CGT for one person-year — the single calculation the engine uses for the bill.
 * Gains are taxed at the lower CGT rate within whatever basic-rate band the income left:
 * `taxableTotal` is already after the personal allowance, so it is compared with the band
 * alone (adding the allowance again would hand gains up to £12,570 of extra low-rate band).
 */
export function personYearTax(inc: YearIncome, p: TaxYearParams, adj?: IncomeTaxAdjustment): PersonYearTax {
  const it = computeIncomeTax(
    { nonSavings: inc.nonSavings, savings: inc.savings, dividends: inc.dividends },
    p,
    adj,
  );
  const basicBandRemaining = Math.max(0, p.basicRateBand - it.taxableTotal);
  const cgt = computeCGT(inc.gain, basicBandRemaining, p);
  return {
    incomeTax: it.tax,
    cgt: cgt.tax,
    total: Math.round((it.tax + cgt.tax) * 100) / 100,
    taxableTotal: it.taxableTotal,
  };
}
