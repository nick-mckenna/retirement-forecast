import type { GiltSelection, PersonId, Rates, StrategyConfig } from "../model/types";
import type { SimState } from "../engine/state";
import type { GiltInstrument } from "../gilts/types";
import { netYield, yieldFromDirty, type GiltPricing } from "../gilts/pricing";
import { accruedPer100, yearsBetween } from "../gilts/schedule";
import { bufferWindow, type NeedFn } from "./buffer";

/** A real gilt chosen for a rung, priced on the purchase date (per £100 nominal, buy side). */
export interface RealGiltChoice {
  isin: string;
  name: string;
  redemptionIso: string;
  clean: number;
  accrued: number;
  dirty: number;
  grossYield: number;
  netYield: number;
  /** The holder's marginal tax rate on savings income the choice was ranked at. */
  taxRate: number;
}

export interface GiltPurchase {
  holder: PersonId;
  nominal: number;
  /** The tax year the gilt funds (for a real gilt, the first one starting on or after its
   *  redemption; for the engine's own, the year of the 6 April it redeems on). */
  maturityYear: number;
  couponRate: number;
  decisionKey: string;
  /** Cash it costs: nominal × dirty price / 100 for a real gilt, the nominal for a par gilt. */
  cost: number;
  /** Set when it is a real gilt; absent for the engine's own par gilts. */
  real?: RealGiltChoice;
}

/** What the ladder needs to buy real gilts. */
export interface RealGiltMarket {
  pricing: GiltPricing;
  /** Buyable conventional gilts (priced, not rump) by the tax year they fund. */
  byFundsYear: Map<number, GiltInstrument[]>;
  /** The purchase (settlement) date, ISO. */
  purchaseIso: string;
  selection: GiltSelection;
  /** Each holder's marginal tax rate on savings income, for ranking by yield after tax. */
  taxRate: Record<PersonId, number>;
}

const PERSONS: PersonId[] = ["nick", "tracy"];

function better(a: RealGiltChoice & { couponRate: number }, b: RealGiltChoice & { couponRate: number }, by: GiltSelection): boolean {
  const eps = 1e-9;
  switch (by) {
    case "lowestCoupon":
      return a.couponRate < b.couponRate - eps || (Math.abs(a.couponRate - b.couponRate) <= eps && a.netYield > b.netYield + eps);
    case "grossYield":
      return a.grossYield > b.grossYield + eps;
    case "netYield":
      return a.netYield > b.netYield + eps || (Math.abs(a.netYield - b.netYield) <= eps && a.couponRate < b.couponRate);
  }
}

/** The best real gilt funding `year` for a holder, by the chosen preference; null if none. */
export function chooseRealGilt(
  m: RealGiltMarket,
  year: number,
  holder: PersonId,
): (RealGiltChoice & { couponRate: number }) | null {
  let best: (RealGiltChoice & { couponRate: number }) | null = null;
  for (const inst of m.byFundsYear.get(year) ?? []) {
    if (inst.redemptionDate <= m.purchaseIso) continue;
    const clean = m.pricing.clean(inst.isin, inst, m.purchaseIso, "buy");
    const accrued = accruedPer100(inst, m.purchaseIso);
    const dirty = clean + accrued;
    if (!(dirty > 0)) continue;
    const c = {
      isin: inst.isin,
      name: inst.name,
      redemptionIso: inst.redemptionDate,
      couponRate: inst.couponRate,
      clean,
      accrued,
      dirty,
      grossYield: yieldFromDirty(inst, m.purchaseIso, dirty),
      netYield: netYield(inst, m.purchaseIso, dirty, m.taxRate[holder], accrued),
      taxRate: m.taxRate[holder],
    };
    if (!best || better(c, best, m.selection)) best = c;
  }
  return best;
}

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
 *
 * With `market`, each rung is bought as a real gilt redeeming in time for it — the one each
 * holder prefers by `market.selection` — sized in nominal (what it repays) and paid for at its
 * price; a rung no real gilt redeems in time for gets a fictional gilt issued at par on the
 * fitted curve. Without it every rung is the engine's own par gilt at `rates.giltCoupon`.
 */
export function planGiltPurchases(
  state: SimState,
  need: NeedFn,
  rates: Rates,
  strategy: StrategyConfig,
  nextTaxYearStart: number,
  reservedCash: Record<PersonId, number> = { nick: 0, tracy: 0 },
  market?: RealGiltMarket,
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
    if (market) {
      if (shortfall <= 100 || householdSpare <= 100) continue;
      householdSpare -= buyRealRung(market, year, shortfall, nextTaxYearStart, personSpare, householdSpare, out);
      continue;
    }
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
        cost: shares[holder],
      });
      personSpare[holder] -= shares[holder];
    }
    householdSpare -= shares.nick + shares.tracy;
  }
  return out;
}

/** One rung of real gilts: each holder's preferred gilt (or a fictional par gilt on the curve if
 *  none redeems in time), half the nominal each where both can afford it, paid at its price.
 *  Appends the purchases and returns the cash they cost. */
function buyRealRung(
  m: RealGiltMarket,
  year: number,
  shortfall: number,
  next: number,
  personSpare: Record<PersonId, number>,
  householdSpare: number,
  out: GiltPurchase[],
): number {
  const choice: Record<PersonId, (RealGiltChoice & { couponRate: number }) | null> = {
    nick: chooseRealGilt(m, year, "nick"),
    tracy: chooseRealGilt(m, year, "tracy"),
  };
  // A fictional gilt is issued at par with a coupon equal to the curve's yield for its term.
  const term = yearsBetween(m.purchaseIso, `${year}-04-06`);
  const parCoupon = Math.max(0, m.pricing.curveYield(term) ?? 0);
  const dirty = (h: PersonId) => choice[h]?.dirty ?? 100;
  const capacity = (h: PersonId) => (personSpare[h] * 100) / dirty(h);

  const nickFirst = Math.min(shortfall / 2, capacity("nick"));
  const tracyShare = Math.min(shortfall - nickFirst, capacity("tracy"));
  const nickShare = Math.min(shortfall - tracyShare, capacity("nick"));
  const shares: Record<PersonId, number> = { nick: nickShare, tracy: tracyShare };
  const total = (shares.nick * dirty("nick") + shares.tracy * dirty("tracy")) / 100;
  if (total > householdSpare) {
    shares.nick *= householdSpare / total;
    shares.tracy *= householdSpare / total;
  }
  let spent = 0;
  for (const holder of PERSONS) {
    // Whole pounds of nominal, rounded down so the cost never exceeds the spare cash.
    const nominal = Math.floor(shares[holder]);
    if (nominal <= 0) continue;
    const c = choice[holder];
    const cost = (nominal * dirty(holder)) / 100;
    out.push({
      holder,
      nominal,
      maturityYear: year,
      couponRate: c ? c.couponRate : parCoupon,
      decisionKey: `${next}:gilt:${holder}:${year}`,
      cost,
      ...(c
        ? {
            real: {
              isin: c.isin,
              name: c.name,
              redemptionIso: c.redemptionIso,
              clean: c.clean,
              accrued: c.accrued,
              dirty: c.dirty,
              grossYield: c.grossYield,
              netYield: c.netYield,
              taxRate: c.taxRate,
            },
          }
        : {}),
    });
    personSpare[holder] -= cost;
    spent += cost;
  }
  return spent;
}
