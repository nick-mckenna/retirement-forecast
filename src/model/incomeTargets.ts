import type { IncomeTargetConfig, Scenario } from "./types";

/** Investable assets that back a safe withdrawal rate: ISA + Pension + GIA (not savings/gilts). */
export function investableAssets(scenario: Scenario): number {
  let total = 0;
  for (const id of ["nick", "tracy"] as const) {
    const b = scenario.balances[id];
    total += b.isa + b.pension + b.gia;
  }
  return total;
}

/**
 * Resolve the income config to a concrete base annual figure. In "swr" mode the year-1 target
 * is derived from the starting investable assets; the rest of the machinery (inflation, income
 * targets table, buffer) then works unchanged off `baseAnnual`.
 */
export function resolveIncome(scenario: Scenario): IncomeTargetConfig {
  if (scenario.income.mode === "swr") {
    return { ...scenario.income, baseAnnual: scenario.income.swrRate * investableAssets(scenario) };
  }
  return scenario.income;
}

export interface IncomeTargetRow {
  /** Tax year start calendar year (6 April of this year). */
  startYear: number;
  /** Tax year end calendar year (5 April of this year). */
  endYear: number;
  annual: number;
  monthly: number;
}

/**
 * Reproduces the "Income Targets" sheet: base annual figure inflated each year.
 * Sheet formula: C[n] = C[n-1] * inflation + C[n-1]; D[n] = C[n] / 12.
 */
export function buildIncomeTargets(cfg: IncomeTargetConfig): IncomeTargetRow[] {
  const rows: IncomeTargetRow[] = [];
  let annual = cfg.baseAnnual;
  for (let i = 0; i < cfg.years; i++) {
    const startYear = cfg.startYear + i;
    if (i > 0) annual = annual * cfg.growth + annual;
    rows.push({
      startYear,
      endYear: startYear + 1,
      annual,
      monthly: annual / 12,
    });
  }
  return rows;
}

/** Annual income target for a given tax-year start year (extrapolates beyond the table). */
export function targetForYear(cfg: IncomeTargetConfig, startYear: number): number {
  const offset = startYear - cfg.startYear;
  if (offset < 0) return cfg.baseAnnual;
  return cfg.baseAnnual * Math.pow(1 + cfg.growth, offset);
}

/** Sum of the income targets for `count` consecutive years starting at `startYear`. */
export function sumTargets(cfg: IncomeTargetConfig, startYear: number, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += targetForYear(cfg, startYear + i);
  return total;
}
