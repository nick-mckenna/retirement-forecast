import type { Scenario } from "../model/types";
import { simulate, type SimResult } from "../engine/simulate";

export interface ForecastOutcome {
  result: SimResult;
  /** Total tax across the whole forecast (income tax + CGT, both people). */
  totalTax: number;
  /**
   * For lifetime mode: the chosen "fill fraction" of the basic-rate band, and the candidates
   * that were searched (fraction -> total tax), so the UI can explain the optimisation.
   */
  chosenFraction?: number;
  search?: { fraction: number | null; totalTax: number }[];
}

export function totalTaxOf(result: SimResult): number {
  return result.years.reduce((s, y) => s + y.tax.nick.total + y.tax.tracy.total, 0);
}

/** Candidate fill levels for the lifetime search: no top-up, then 0 (PA) .. 1 (top of basic band). */
const LIFETIME_CANDIDATES: (number | null)[] = [null, 0, 0.25, 0.5, 0.75, 1];

/**
 * Run the forecast for a scenario. For "lifetime" tax mode this searches a family of
 * pension-crystallisation strategies (how far up the basic-rate band to fill each year) by
 * fully simulating each candidate, and returns the one with the lowest total lifetime tax.
 * For "heuristic"/"annual" it just simulates once.
 */
export function runForecast(scenario: Scenario): ForecastOutcome {
  if (scenario.strategy.taxMode !== "lifetime") {
    const result = simulate(scenario);
    return { result, totalTax: totalTaxOf(result) };
  }

  let best: ForecastOutcome | null = null;
  const search: { fraction: number | null; totalTax: number }[] = [];
  for (const fraction of LIFETIME_CANDIDATES) {
    const candidate: Scenario = {
      ...scenario,
      strategy: { ...scenario.strategy, lifetimeFillFraction: fraction ?? undefined },
    };
    const result = simulate(candidate);
    const totalTax = totalTaxOf(result);
    search.push({ fraction, totalTax });
    if (!best || totalTax < best.totalTax) {
      best = { result, totalTax, chosenFraction: fraction ?? undefined, search };
    }
  }
  best!.search = search;
  return best!;
}
