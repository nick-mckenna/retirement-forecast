import type { IncomeTargetConfig, PersonId, Rates, StrategyConfig } from "../model/types";
import { targetForYear } from "../model/incomeTargets";
import type { SimState } from "../engine/state";
import { giltValue } from "../engine/state";

export interface GiltPurchase {
  holder: PersonId;
  nominal: number;
  maturityYear: number;
  couponRate: number;
  decisionKey: string;
}

/**
 * Maintain a rolling gilt ladder: keep roughly (bufferYears - 1) years of income in
 * gilts, laddered so about one rung matures each year. Each year we buy one new rung
 * (sized ~1 year of income) maturing `giltLadderYears` out, funded from spare cash.
 * Gilts are split across both people so each uses their own personal savings allowance
 * on the (taxable) coupon, while the capital return stays CGT-free.
 */
export function planGiltPurchases(
  state: SimState,
  income: IncomeTargetConfig,
  rates: Rates,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
): GiltPurchase[] {
  const oneYear = targetForYear(income, nextTaxYearStart);
  const giltHoldTarget = Math.max(0, (strategy.bufferYears - 1) * oneYear);
  const currentGilts = giltValue(state);
  if (currentGilts >= giltHoldTarget) return [];

  // Cash available to convert into gilts, keeping ~1 year of income as spending cash.
  const cash = state.balances.nick.savings + state.balances.tracy.savings;
  const spendingCashFloor = oneYear;
  const investible = Math.min(giltHoldTarget - currentGilts, Math.max(0, cash - spendingCashFloor));
  if (investible <= 100) return [];

  const rung = Math.min(investible, oneYear); // one rung ~ one year of income
  const maturityYear = nextTaxYearStart + Math.max(1, strategy.giltLadderYears);
  const half = rung / 2;

  const out: GiltPurchase[] = [
    {
      holder: "nick",
      nominal: round0(half),
      maturityYear,
      couponRate: rates.giltCoupon,
      decisionKey: `${nextTaxYearStart}:gilt:nick`,
    },
    {
      holder: "tracy",
      nominal: round0(half),
      maturityYear,
      couponRate: rates.giltCoupon,
      decisionKey: `${nextTaxYearStart}:gilt:tracy`,
    },
  ];
  return out.filter((g) => g.nominal > 0);
}

function round0(x: number): number {
  return Math.round(x);
}
