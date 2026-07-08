// Core domain model for the retirement forecast.
// All monetary values are in nominal GBP unless stated otherwise.

export type PersonId = "nick" | "tracy";

/** The five per-person account "pots" tracked in the original spreadsheet. */
export type AccountKind = "isa" | "pension" | "gia" | "savings";

export interface Person {
  id: PersonId;
  name: string;
  /** ISO date (yyyy-mm-dd). */
  dob: string;
  /** Age at which this person can first access their (DC) pension. Default 57 from Apr 2028. */
  pensionAccessAge: number;
  /** Age at which the State Pension starts. */
  statePensionAge: number;
  /** Annual State Pension in today's money at the model start; inflated to payment date. */
  statePensionAnnual: number;
}

export interface StartingBalances {
  isa: number;
  pension: number;
  gia: number;
  savings: number;
  /** Total value of gilts already held at the start (added to first ladder rung). */
  gilts: number;
  /**
   * Assumed embedded capital gain fraction of the GIA (0..1). Used so that GIA
   * disposals crystallise a realistic gain for CGT. e.g. 0.4 = 40% of a sale is gain.
   */
  giaGainFraction: number;
}

export interface Rates {
  /** Annual investment (stocks & shares) growth, e.g. 0.07. */
  investmentGrowth: number;
  /** Annual cash/savings interest, e.g. 0.035. */
  savingsInterest: number;
  /** Annual inflation used to grow income targets & (optionally) tax thresholds, e.g. 0.03. */
  inflation: number;
  /** Assumed coupon rate on newly purchased gilts (taxable savings income). */
  giltCoupon: number;
  /** Assumed dividend yield within the GIA (taxable as dividends). 0 to ignore. */
  giaDividendYield: number;
}

export interface IncomeTargetConfig {
  /**
   * How the year-1 income target is set:
   * - "fixed": use `baseAnnual` directly.
   * - "swr": year-1 income = `swrRate` × investable assets (ISA + Pension + GIA, excluding
   *   savings & gilts) at the model start. Either way it then rises each year by `growth`.
   */
  mode: "fixed" | "swr";
  /** Target net annual income for the first tax year (fixed mode). */
  baseAnnual: number;
  /** Safe withdrawal rate applied to starting investable assets (swr mode), e.g. 0.035. */
  swrRate: number;
  /** First tax year start year (calendar year of 6 April). */
  startYear: number;
  /** Number of tax years to model. */
  years: number;
  /** Annual growth of the income target (usually = inflation). */
  growth: number;
}

/** UK tax parameters for a single tax year. All editable in the UI. */
export interface TaxYearParams {
  /** Tax year start calendar year (e.g. 2028 for 2028/29). */
  year: number;
  personalAllowance: number;
  /** Income above this tapers the personal allowance by £1 per £2. */
  paTaperThreshold: number;
  /** Width of the basic-rate band above the personal allowance. */
  basicRateBand: number;
  /** Income above (PA + basicRateBand + higherRateBand) is taxed at the additional rate. */
  higherRateBand: number;
  basicRate: number;
  higherRate: number;
  additionalRate: number;
  /** Personal Savings Allowance for basic / higher / additional rate taxpayers. */
  psaBasic: number;
  psaHigher: number;
  /** Starting rate band for savings (0% band that reduces as non-savings income rises). */
  savingsStartingRateBand: number;
  dividendAllowance: number;
  dividendBasicRate: number;
  dividendHigherRate: number;
  dividendAdditionalRate: number;
  cgtAnnualExempt: number;
  cgtBasicRate: number;
  cgtHigherRate: number;
  isaAllowance: number;
}

export interface StrategyConfig {
  /** Years of income to hold as the cash + gilts buffer (the "Savings & Gilts" column). */
  bufferYears: number;
  /** Whether to auto-run the tax-efficient drawdown/refill each year. */
  autoStrategy: boolean;
  /**
   * If true, deliberately draw pension up to each person's personal allowance every
   * year (even if not needed for income) to extract the pension tax-efficiently.
   */
  fillPersonalAllowanceFromPension: boolean;
  /** Preserve ISA as long as possible (draw taxable sources first). */
  preserveIsa: boolean;
  /** Target maturity ladder length in years for newly bought gilts. */
  giltLadderYears: number;
  /**
   * How to choose which investments to sell when raising the annual cash:
   * - "heuristic": fixed tax-aware priority order (uses preserveIsa / fillPersonalAllowanceFromPension).
   * - "annual": true optimiser — minimises the current tax year's tax on the required raise.
   * - "lifetime": searches an annual taxable-income target to minimise total tax over the forecast.
   */
  taxMode: "heuristic" | "annual" | "lifetime";
  /**
   * Internal (lifetime mode): how far up the basic-rate band to fill each person's taxable
   * income by crystallising pension — 0 = up to the personal allowance (0% tax), 1 = up to the
   * top of the basic-rate band. Resolved per year against that year's thresholds. Set by the
   * optimiser search; undefined means no proactive crystallisation.
   */
  lifetimeFillFraction?: number;
}

/** A user override for a specific auto-generated transaction, keyed by a stable id. */
export interface Override {
  /** e.g. "2030:refill:nick:pension" */
  key: string;
  /** New gross amount to raise/sell from that source (replaces the auto value). */
  amount: number;
}

/** A one-off large cash requirement on a specific date (e.g. buying a house). */
export interface OneOffPurchase {
  id: string;
  label: string;
  /** ISO date (yyyy-mm-dd) the cash is needed. */
  date: string;
  /** Cash required; funded by selling investments tax-efficiently on that date. */
  amount: number;
}

export interface Scenario {
  id: string;
  name: string;
  /** ISO date of the model start (the "Starting Balances" row). */
  startDate: string;
  /**
   * When true, the starting balances (isa/pension/gia/savings/gilts +
   * giaGainFraction) are computed live from the pre-retirement projection
   * sampled at `startDate` (savings + premium bonds merge into `savings`);
   * the manual `balances` fields are kept but ignored while linked.
   */
  linkPreRetirement: boolean;
  people: Record<PersonId, Person>;
  balances: Record<PersonId, StartingBalances>;
  rates: Rates;
  income: IncomeTargetConfig;
  strategy: StrategyConfig;
  /** One-off final employment income received on the first day of the new tax year. */
  finalIncome: {
    date: string;
    perPerson: Record<PersonId, { net: number; tax: number }>;
  };
  /** Editable per-year tax parameters. Missing years fall back to the projected default. */
  taxParams: TaxYearParams[];
  overrides: Override[];
  /** One-off large cash requirements (house purchase, car, etc.). */
  purchases: OneOffPurchase[];
}
