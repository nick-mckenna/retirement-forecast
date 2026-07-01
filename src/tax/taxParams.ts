import type { TaxYearParams } from "../model/types";

// Best-known England & Wales figures as a baseline (2025/26 basis). These are a
// planning aid, NOT tax advice — every value is editable in the UI, and future-year
// thresholds are assumptions. Thresholds are frozen until `freezeUntilYear`, then
// assumed to rise with `uprating`.
export const BASE_TAX_PARAMS: Omit<TaxYearParams, "year"> = {
  personalAllowance: 12570,
  paTaperThreshold: 100000,
  basicRateBand: 37700,
  higherRateBand: 87440, // 125140 - (12570 + 37700)
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  psaBasic: 1000,
  psaHigher: 500,
  savingsStartingRateBand: 5000,
  dividendAllowance: 500,
  dividendBasicRate: 0.0875,
  dividendHigherRate: 0.3375,
  dividendAdditionalRate: 0.3935,
  cgtAnnualExempt: 3000,
  cgtBasicRate: 0.18,
  cgtHigherRate: 0.24,
  isaAllowance: 20000,
};

/** Thresholds are frozen (in cash terms) up to and including this tax year. */
export const FREEZE_UNTIL_YEAR = 2028;

/** Fields that are cash thresholds/allowances and should be uprated after the freeze. */
const UPRATED_FIELDS: (keyof Omit<TaxYearParams, "year">)[] = [
  "personalAllowance",
  "basicRateBand",
  "higherRateBand",
  "psaBasic",
  "psaHigher",
  "savingsStartingRateBand",
  "dividendAllowance",
  "cgtAnnualExempt",
  "isaAllowance",
];

/** Project the default tax parameters for a given year using an uprating assumption. */
export function projectTaxParams(year: number, uprating: number): TaxYearParams {
  const p: TaxYearParams = { year, ...BASE_TAX_PARAMS };
  if (year > FREEZE_UNTIL_YEAR) {
    const factor = Math.pow(1 + uprating, year - FREEZE_UNTIL_YEAR);
    for (const f of UPRATED_FIELDS) {
      // Round to whole pounds to keep the tables readable.
      p[f] = Math.round((BASE_TAX_PARAMS[f] as number) * factor);
    }
  }
  return p;
}

/**
 * Resolve the params for a year: prefer an explicit user-edited row, else project.
 */
export function resolveTaxParams(
  edited: TaxYearParams[],
  year: number,
  uprating: number,
): TaxYearParams {
  const hit = edited.find((t) => t.year === year);
  return hit ?? projectTaxParams(year, uprating);
}
