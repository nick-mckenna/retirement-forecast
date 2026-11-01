import type { Scenario, StrategyConfig } from "../model/types";
import { simulate, type SimResult } from "../engine/simulate";
import type { SimContext } from "../gilts/types";

/** One candidate the lifetime search tried. */
export interface SearchCandidate {
  /** "heuristic" / "annual" = that mode's plan as is; "fill" = annual-mode sales plus proactive
   *  crystallisation up to `fraction` of the basic-rate band each year. */
  strategy: "heuristic" | "annual" | "fill";
  fraction: number | null;
  totalTax: number;
}

export interface ForecastOutcome {
  result: SimResult;
  /** Total tax across the whole forecast (income tax + CGT, both people). */
  totalTax: number;
  /**
   * For lifetime mode: the winning candidate and every candidate searched, so the UI can
   * explain the optimisation. `chosenFraction` is set only when a fill level won.
   */
  chosen?: SearchCandidate;
  chosenFraction?: number;
  search?: SearchCandidate[];
}

export function totalTaxOf(result: SimResult): number {
  return result.years.reduce((s, y) => s + y.tax.nick.total + y.tax.tracy.total, 0);
}

/** First pass over fill levels: 0 (the personal allowance) .. 1 (the top of the basic band). */
const COARSE_FILLS = [0, 0.2, 0.4, 0.6, 0.8, 1];
/** Then refine around the best one (the response is jagged, so a coarse grid alone misses). */
const REFINE_STEPS = [-0.1, -0.05, 0.05, 0.1];

/**
 * Run the forecast for a scenario. For "lifetime" tax mode this searches whole-plan strategies
 * by fully simulating each — the rules-based plan, the annual optimiser, and the annual
 * optimiser with proactive pension crystallisation filled to a range of basic-band fractions,
 * refined around the best — and returns the one with the lowest total lifetime tax (the
 * objective is lifetime tax, as chosen; deferred tax on pensions left at the horizon isn't in
 * it). For "heuristic"/"annual" it just simulates once. `ctx` goes to every simulate run.
 */
export function runForecast(scenario: Scenario, ctx: SimContext = {}): ForecastOutcome {
  if (scenario.strategy.taxMode !== "lifetime") {
    const result = simulate(scenario, ctx);
    return { result, totalTax: totalTaxOf(result) };
  }

  const search: SearchCandidate[] = [];
  let best: { candidate: SearchCandidate; result: SimResult } | null = null;
  const tried = new Set<string>();
  const run = (strategy: SearchCandidate["strategy"], fraction: number | null) => {
    const key = `${strategy}:${fraction ?? ""}`;
    if (tried.has(key)) return;
    tried.add(key);
    const config: StrategyConfig = {
      ...scenario.strategy,
      taxMode: strategy === "heuristic" ? "heuristic" : "lifetime",
      lifetimeFillFraction: fraction ?? undefined,
    };
    const result = simulate({ ...scenario, strategy: config }, ctx);
    const candidate: SearchCandidate = { strategy, fraction, totalTax: totalTaxOf(result) };
    search.push(candidate);
    if (!best || candidate.totalTax < best.candidate.totalTax - 0.005) best = { candidate, result };
  };

  run("heuristic", null);
  run("annual", null);
  for (const f of COARSE_FILLS) run("fill", f);
  const bestFill = search
    .filter((c) => c.strategy === "fill")
    .reduce((a, b) => (b.totalTax < a.totalTax ? b : a));
  for (const d of REFINE_STEPS) {
    const f = Math.round(((bestFill.fraction ?? 0) + d) * 100) / 100;
    if (f >= 0 && f <= 1) run("fill", f);
  }

  const { candidate, result } = best!;
  return {
    result,
    totalTax: candidate.totalTax,
    chosen: candidate,
    chosenFraction: candidate.strategy === "fill" ? (candidate.fraction ?? undefined) : undefined,
    search,
  };
}
