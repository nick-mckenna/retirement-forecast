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
 *
 * `reservedCash` is each person's cash already committed (their tax bill for the year, paid
 * right after the ladder is bought) and so not available to invest.
 */
export function planGiltPurchases(
  state: SimState,
  income: IncomeTargetConfig,
  rates: Rates,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
  reservedCash: Record<PersonId, number> = { nick: 0, tracy: 0 },
): GiltPurchase[] {
  const oneYear = targetForYear(income, nextTaxYearStart);
  const giltHoldTarget = Math.max(0, (strategy.bufferYears - 1) * oneYear);
  const currentGilts = giltValue(state);
  if (currentGilts >= giltHoldTarget) return [];

  // Cash available to convert into gilts, keeping ~1 year of income as spending cash.
  // (The tax reservation only bites when the buffer is below target: one refilled to target
  // already holds more than the gilt hold target plus a year of cash.)
  const free = (id: PersonId) => state.balances[id].savings - reservedCash[id];
  const cash = free("nick") + free("tracy");
  const spendingCashFloor = oneYear;
  const investible = Math.min(giltHoldTarget - currentGilts, Math.max(0, cash - spendingCashFloor));
  if (investible <= 100) return [];

  const rung = Math.min(investible, oneYear); // one rung ~ one year of income
  const maturityYear = nextTaxYearStart + Math.max(1, strategy.giltLadderYears);

  // Split the rung half each where both can afford it, but never beyond a person's own spare
  // cash (after their tax and their half of the spending floor) — otherwise one person's
  // cash goes negative at year end while the household's is fine. Whatever one can't take
  // goes to the other; between them their spare cash always covers the rung, since
  // rung <= cash - floor <= spare(nick) + spare(tracy).
  const spare = (id: PersonId) => Math.max(0, free(id) - spendingCashFloor / 2);
  const nickFirst = Math.min(rung / 2, spare("nick"));
  const tracyShare = Math.min(rung - nickFirst, spare("tracy"));
  const nickShare = Math.min(rung - tracyShare, spare("nick"));

  const out: GiltPurchase[] = [
    {
      holder: "nick",
      nominal: round0(nickShare),
      maturityYear,
      couponRate: rates.giltCoupon,
      decisionKey: `${nextTaxYearStart}:gilt:nick`,
    },
    {
      holder: "tracy",
      nominal: round0(tracyShare),
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
