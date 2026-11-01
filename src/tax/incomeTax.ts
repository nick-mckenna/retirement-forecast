import type { TaxYearParams } from "../model/types";

export interface IncomeParts {
  /** Non-savings, non-dividend income: pension drawdown (taxable portion), state pension, earnings. */
  nonSavings: number;
  /** Savings income: cash interest + gilt coupons. */
  savings: number;
  /** Dividend income (from the GIA). */
  dividends: number;
}

export interface IncomeTaxResult {
  tax: number;
  personalAllowanceUsed: number;
  /** Taxable income after the personal allowance (0%-rated slices such as the PSA included). */
  taxableTotal: number;
  breakdown: {
    nonSavingsTax: number;
    savingsTax: number;
    dividendTax: number;
  };
}

interface BandSplit {
  basic: number;
  higher: number;
  additional: number;
  cum: number;
}

function splitBands(amount: number, cum: number, p: TaxYearParams): BandSplit {
  const basicTop = p.basicRateBand;
  const higherTop = p.basicRateBand + p.higherRateBand;
  let remaining = amount;

  const basicRoom = Math.max(0, basicTop - cum);
  const basic = Math.min(remaining, basicRoom);
  remaining -= basic;
  cum += basic;

  const higherRoom = Math.max(0, higherTop - cum);
  const higher = Math.min(remaining, higherRoom);
  remaining -= higher;
  cum += higher;

  const additional = remaining;
  cum += additional;

  return { basic, higher, additional, cum };
}

/**
 * Compute UK income tax for one person for one tax year.
 * Ordering: personal allowance then bands are filled by non-savings, then savings,
 * then dividends. Savings get the starting-rate band + personal savings allowance at 0%;
 * dividends get the dividend allowance at 0%. PA is tapered above the taper threshold.
 */
/** Marriage-allowance adjustments: the transferor gives up `paReduction` of personal
 *  allowance; the recipient gets `taxReducer` off their income tax (never below zero). */
export interface IncomeTaxAdjustment {
  paReduction?: number;
  taxReducer?: number;
}

export function computeIncomeTax(parts: IncomeParts, p: TaxYearParams, adj: IncomeTaxAdjustment = {}): IncomeTaxResult {
  const nonSavings = Math.max(0, parts.nonSavings);
  const savings = Math.max(0, parts.savings);
  const dividends = Math.max(0, parts.dividends);
  const total = nonSavings + savings + dividends;

  const paEff = Math.max(
    0,
    p.personalAllowance - Math.max(0, (total - p.paTaperThreshold) / 2) - (adj.paReduction ?? 0),
  );

  // Allocate personal allowance: non-savings, then savings, then dividends.
  let paLeft = paEff;
  const nsAfterPA = Math.max(0, nonSavings - paLeft);
  paLeft = Math.max(0, paLeft - nonSavings);
  const savAfterPA = Math.max(0, savings - paLeft);
  paLeft = Math.max(0, paLeft - savings);
  const divAfterPA = Math.max(0, dividends - paLeft);

  const taxableTotal = nsAfterPA + savAfterPA + divAfterPA;

  // Personal Savings Allowance depends on the highest band reached by total taxable income.
  let psa: number;
  if (taxableTotal <= p.basicRateBand) psa = p.psaBasic;
  else if (taxableTotal <= p.basicRateBand + p.higherRateBand) psa = p.psaHigher;
  else psa = 0;

  // Starting rate for savings: reduced £1-for-£1 by non-savings taxable income.
  const startingRateBand = Math.max(0, p.savingsStartingRateBand - nsAfterPA);

  let cum = 0;
  let nonSavingsTax = 0;
  let savingsTax = 0;
  let dividendTax = 0;

  // --- Non-savings income ---
  {
    const s = splitBands(nsAfterPA, cum, p);
    nonSavingsTax = s.basic * p.basicRate + s.higher * p.higherRate + s.additional * p.additionalRate;
    cum = s.cum;
  }

  // --- Savings income: 0% portion (starting rate + PSA) first, then the savings rates ---
  {
    const zeroPortion = Math.min(savAfterPA, startingRateBand + psa);
    // 0% portion still occupies band space.
    cum += zeroPortion;
    const taxablePortion = savAfterPA - zeroPortion;
    const s = splitBands(taxablePortion, cum, p);
    savingsTax =
      s.basic * p.savingsBasicRate + s.higher * p.savingsHigherRate + s.additional * p.savingsAdditionalRate;
    cum = s.cum;
  }

  // --- Dividend income: dividend allowance at 0% first, then dividend rates ---
  {
    const zeroPortion = Math.min(divAfterPA, p.dividendAllowance);
    cum += zeroPortion;
    const taxablePortion = divAfterPA - zeroPortion;
    const s = splitBands(taxablePortion, cum, p);
    dividendTax =
      s.basic * p.dividendBasicRate +
      s.higher * p.dividendHigherRate +
      s.additional * p.dividendAdditionalRate;
    cum = s.cum;
  }

  const tax = round2(Math.max(0, nonSavingsTax + savingsTax + dividendTax - (adj.taxReducer ?? 0)));

  return {
    tax,
    personalAllowanceUsed: paEff,
    taxableTotal,
    breakdown: {
      nonSavingsTax: round2(nonSavingsTax),
      savingsTax: round2(savingsTax),
      dividendTax: round2(dividendTax),
    },
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
