import type { IncomeTargetConfig, StrategyConfig } from "../model/types";
import { sumTargets } from "../model/incomeTargets";
import type { SimState } from "../engine/state";
import { giltValue } from "../engine/state";

/**
 * The "Savings & Gilts" buffer target: N years of upcoming income held as cash + gilts.
 * Keeping ~3 years balances inflation risk (too much cash) against crash risk (too little).
 */
export function bufferTarget(
  income: IncomeTargetConfig,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
): number {
  return sumTargets(income, nextTaxYearStart, strategy.bufferYears);
}

export function currentBuffer(state: SimState): number {
  const cash = state.balances.nick.savings + state.balances.tracy.savings;
  return cash + giltValue(state);
}

/** Positive = need to sell investments to refill; negative = buffer already exceeds target. */
export function bufferShortfall(
  state: SimState,
  income: IncomeTargetConfig,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
): number {
  return bufferTarget(income, strategy, nextTaxYearStart) - currentBuffer(state);
}
