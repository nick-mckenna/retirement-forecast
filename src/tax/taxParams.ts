import type { TaxPolicy, TaxYearOverride, TaxYearParams } from "../model/types";

// Best-known England & Wales figures. These are a planning aid, NOT tax advice — every
// value is editable per year in the UI, and future-year thresholds are assumptions.

export type TaxParamFields = Omit<TaxYearParams, "year">;

/** Every tax-year parameter, in display order — the canonical list used by the editor, the
 *  SQL mapping and migration, so a new field can't be half-wired. */
export const TAX_PARAM_FIELDS: (keyof TaxParamFields)[] = [
  "personalAllowance",
  "paTaperThreshold",
  "basicRateBand",
  "higherRateBand",
  "basicRate",
  "higherRate",
  "additionalRate",
  "savingsStartingRateBand",
  "psaBasic",
  "psaHigher",
  "savingsBasicRate",
  "savingsHigherRate",
  "savingsAdditionalRate",
  "dividendAllowance",
  "dividendBasicRate",
  "dividendHigherRate",
  "dividendAdditionalRate",
  "cgtAnnualExempt",
  "cgtBasicRate",
  "cgtHigherRate",
  "isaAllowance",
];

/** 2025/26 — the baseline every later year starts from. */
export const BASE_TAX_PARAMS: TaxParamFields = {
  personalAllowance: 12570,
  paTaperThreshold: 100000,
  basicRateBand: 37700,
  higherRateBand: 87440, // 125140 - 37700 (additional rate starts at £125,140 taxable)
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  psaBasic: 1000,
  psaHigher: 500,
  savingsStartingRateBand: 5000,
  savingsBasicRate: 0.2,
  savingsHigherRate: 0.4,
  savingsAdditionalRate: 0.45,
  dividendAllowance: 500,
  dividendBasicRate: 0.0875,
  dividendHigherRate: 0.3375,
  dividendAdditionalRate: 0.3935,
  cgtAnnualExempt: 3000,
  cgtBasicRate: 0.18,
  cgtHigherRate: 0.24,
  isaAllowance: 20000,
};

/** Announced changes to the baseline, each applying from its tax year onwards (in order). */
export const BASELINE_SCHEDULE: { fromYear: number; changes: Partial<TaxParamFields>; source: string }[] = [
  {
    fromYear: 2026,
    changes: { dividendBasicRate: 0.1075, dividendHigherRate: 0.3575 },
    source: "Budget 2025 — gov.uk policy paper, 27 Nov 2025 (additional dividend rate unchanged)",
  },
  {
    fromYear: 2027,
    changes: { savingsBasicRate: 0.24, savingsHigherRate: 0.44, savingsAdditionalRate: 0.49 },
    source: "Autumn Budget 2026 (28 Oct 2026), superseding Budget 2025's 22/42/47 — pending Finance Bill 2026-27",
  },
];

/**
 * Default policy: thresholds frozen to 5 April 2031 (2030/31 is the last frozen year), then
 * the statutory default — the personal allowance and basic-rate limit rise with inflation.
 */
export const DEFAULT_TAX_POLICY: TaxPolicy = { freezeUntilYear: 2030, indexation: "statutory", uprating: 0 };

/** Indexed by statute (CPI) once a freeze ends. */
const STATUTORY_INDEXED: (keyof TaxParamFields)[] = ["personalAllowance", "basicRateBand"];

/** Raised by a "custom" uprating. The £125,140 additional-rate threshold and £100,000 taper
 *  threshold are fixed amounts in law, so they never move. */
const CUSTOM_UPRATED: (keyof TaxParamFields)[] = [
  "personalAllowance",
  "basicRateBand",
  "psaBasic",
  "psaHigher",
  "savingsStartingRateBand",
  "dividendAllowance",
  "cgtAnnualExempt",
  "isaAllowance",
];

/** The baseline for a year: 2025/26 plus every scheduled change that has taken effect. */
export function baselineFor(year: number): TaxParamFields {
  let p: TaxParamFields = { ...BASE_TAX_PARAMS };
  for (const entry of BASELINE_SCHEDULE) if (year >= entry.fromYear) p = { ...p, ...entry.changes };
  return p;
}

/** Project the default tax parameters for a year under a freeze/indexation policy.
 *  `inflation` drives statutory indexation (the scenario's `rates.inflation`). */
export function projectTaxParams(year: number, policy: TaxPolicy, inflation: number): TaxYearParams {
  const base = baselineFor(year);
  const p: TaxYearParams = { year, ...base };
  const yearsAfterFreeze = year - policy.freezeUntilYear;
  const rate = policy.indexation === "statutory" ? inflation : policy.uprating;
  if (yearsAfterFreeze > 0 && rate !== 0) {
    const factor = Math.pow(1 + rate, yearsAfterFreeze);
    const fields = policy.indexation === "statutory" ? STATUTORY_INDEXED : CUSTOM_UPRATED;
    for (const f of fields) {
      // Round to whole pounds to keep the tables readable.
      p[f] = Math.round(base[f] * factor);
    }
    // The additional rate stays at the fixed £125,140 of taxable income: as the basic band
    // grows the higher band narrows (to nothing, eventually — as the law literally implies).
    p.higherRateBand = Math.max(0, base.basicRateBand + base.higherRateBand - p.basicRateBand);
  }
  return p;
}

/** Resolve the params for a year: the projection, with any fields the user edited for that
 *  year laid over it. */
export function resolveTaxParams(
  edited: TaxYearOverride[],
  year: number,
  policy: TaxPolicy,
  inflation: number,
): TaxYearParams {
  const p = projectTaxParams(year, policy, inflation);
  const hit = edited.find((t) => t.year === year);
  if (!hit) return p;
  for (const f of TAX_PARAM_FIELDS) {
    const v = hit[f];
    if (typeof v === "number" && Number.isFinite(v)) p[f] = v;
  }
  return p;
}
