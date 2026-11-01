import type { PersonId, Rates, StrategyConfig } from "../model/types";
import type { SimState } from "../engine/state";
import { bufferWindow, type NeedFn } from "./buffer";

export interface GiltPurchase {
  holder: PersonId;
  nominal: number;
  maturityYear: number;
  couponRate: number;
  decisionKey: string;
}

const PERSONS: PersonId[] = ["nick", "tracy"];

/**
 * A liability-matched, self-repairing gilt ladder. The buffer covers the next N tax years'
 * income need (net of State Pension): next year from cash plus the gilts maturing on its
 * 6 April, each later year in the window from gilts maturing at its start. So each year end we
 * buy, nearest year first, whatever each later window year (up to `giltLadderYears` ahead) is
 * still short — a rung that came up small is topped up the next year instead of the shape
 * repeating forever — funded only from cash beyond next year's own need.
 *
 * Gilts are split across both people so each uses their own personal savings allowance on the
 * (taxable) coupon, while the capital return stays CGT-free. `reservedCash` is each person's
 * cash already committed (their tax for the year, paid right after the ladder is bought).
 */
export function planGiltPurchases(
  state: SimState,
  need: NeedFn,
  rates: Rates,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
  reservedCash: Record<PersonId, number> = { nick: 0, tracy: 0 },
): GiltPurchase[] {
  const held = (year: number) =>
    state.gilts.filter((g) => g.maturityYear === year).reduce((s, g) => s + g.nominal, 0);

  // Next year is paid from cash plus what matures on its 6 April; keep that much cash back.
  const spendingCashFloor = Math.max(0, need(nextTaxYearStart) - held(nextTaxYearStart));
  const free = (id: PersonId) => state.balances[id].savings - reservedCash[id];
  let householdSpare = Math.max(0, free("nick") + free("tracy") - spendingCashFloor);
  if (householdSpare <= 100) return [];

  // Each person keeps half the floor and their own tax; between them their spare cash always
  // covers what the household can spend, since Σ max(0, free − floor/2) ≥ Σ free − floor.
  const personSpare: Record<PersonId, number> = {
    nick: Math.max(0, free("nick") - spendingCashFloor / 2),
    tracy: Math.max(0, free("tracy") - spendingCashFloor / 2),
  };

  const lastRung = nextTaxYearStart + Math.max(1, strategy.giltLadderYears);
  const out: GiltPurchase[] = [];
  for (const { year, weight } of bufferWindow(strategy, nextTaxYearStart)) {
    if (year === nextTaxYearStart || year > lastRung) continue;
    const shortfall = Math.max(0, need(year) * weight - held(year));
    const rung = Math.min(shortfall, householdSpare);
    if (rung <= 100) continue;
    // Half each where both can afford it; whatever one can't take goes to the other.
    const nickFirst = Math.min(rung / 2, personSpare.nick);
    const tracyShare = Math.min(rung - nickFirst, personSpare.tracy);
    const nickShare = Math.min(rung - tracyShare, personSpare.nick);
    // Whole pounds, rounded down so a share never exceeds the person's spare cash.
    const shares: Record<PersonId, number> = { nick: Math.floor(nickShare), tracy: Math.floor(tracyShare) };
    for (const holder of PERSONS) {
      if (shares[holder] <= 0) continue;
      out.push({
        holder,
        nominal: shares[holder],
        maturityYear: year,
        couponRate: rates.giltCoupon,
        decisionKey: `${nextTaxYearStart}:gilt:${holder}:${year}`,
      });
      personSpare[holder] -= shares[holder];
    }
    householdSpare -= shares.nick + shares.tracy;
  }
  return out;
}
