import type { StrategyConfig } from "../model/types";
import type { GiltHolding, SimState } from "../engine/state";

/** The income the buffer has to fund in a tax year: the income target less the State Pension
 *  paid that year (which arrives as cash anyway), never below zero. */
export type NeedFn = (taxYearStart: number) => number;

/** The tax years the buffer covers from `nextTaxYearStart`, each with its weight: whole years,
 *  then the fraction of the next one for a fractional `bufferYears` (2.5 = two years + half). */
export function bufferWindow(
  strategy: StrategyConfig,
  nextTaxYearStart: number,
): { year: number; weight: number }[] {
  const n = Math.max(0, strategy.bufferYears);
  const whole = Math.floor(n);
  const out: { year: number; weight: number }[] = [];
  for (let i = 0; i < whole; i++) out.push({ year: nextTaxYearStart + i, weight: 1 });
  const frac = n - whole;
  if (frac > 1e-9) out.push({ year: nextTaxYearStart + whole, weight: frac });
  return out;
}

/**
 * The "Savings & Gilts" buffer target: N years of upcoming income need held as cash + gilts —
 * net of State Pension, so the buffer isn't oversized once it is in payment. Keeping ~3 years
 * balances inflation risk (too much cash) against crash risk (too little).
 */
export function bufferTarget(need: NeedFn, strategy: StrategyConfig, nextTaxYearStart: number): number {
  return bufferWindow(strategy, nextTaxYearStart).reduce((s, { year, weight }) => s + need(year) * weight, 0);
}

/** Cash, Premium Bonds and gilts. Gilts count at their redemption value (nominal) by default;
 *  `value` lets the engine count a long-dated real gilt — one maturing beyond the buffer
 *  window — at its market value instead. */
export function currentBuffer(state: SimState, value: (g: GiltHolding) => number = (g) => g.nominal): number {
  const { nick, tracy } = state.balances;
  const cash = nick.savings + nick.premiumBonds + tracy.savings + tracy.premiumBonds;
  return cash + state.gilts.reduce((s, g) => s + value(g), 0);
}
