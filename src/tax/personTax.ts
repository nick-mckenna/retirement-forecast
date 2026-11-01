import type { TaxYearParams } from "../model/types";
import { computeCGT } from "./cgt";
import { computeIncomeTax } from "./incomeTax";

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
export function personYearTax(inc: YearIncome, p: TaxYearParams): PersonYearTax {
  const it = computeIncomeTax(
    { nonSavings: inc.nonSavings, savings: inc.savings, dividends: inc.dividends },
    p,
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
