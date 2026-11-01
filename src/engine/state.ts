import type { PersonId, Scenario } from "../model/types";
import { firstModelledTaxYear, parseDate } from "../tax/taxYear";
import { LUMP_SUM_ALLOWANCE } from "../tax/pensionDraw";
import type { OpeningGilt } from "../gilts/types";
import { fundsYear } from "../gilts/schedule";

export interface AccountState {
  isa: number;
  pension: number;
  gia: number;
  savings: number;
  /** Cost basis of the GIA holding, for CGT on disposals (proportional cost method). */
  giaBasis: number;
  /** Lump Sum Allowance still available: pension draws are 25% tax-free only while it lasts. */
  lsaRemaining: number;
  /** Premium Bonds: cash-like, tax-free prizes; shown inside the savings (cash) column. */
  premiumBonds: number;
}

/**
 * A gilt holding. Two kinds:
 *  - the engine's own (fictional) gilts — `redemptionIso` undefined: redeemed at par on
 *    6 April of `maturityYear`, with one annual coupon paid at the start of each tax year;
 *  - real gilts (handed over from the pre-retirement module) — `redemptionIso` set: redeemed on
 *    that date, coupons half-yearly on its day-of-month, valued and sold at market prices.
 */
export interface GiltHolding {
  id: string;
  holder: PersonId;
  /** Display name / rung, e.g. "G2038", or the DMO name of a real gilt. */
  name: string;
  nominal: number;
  couponRate: number;
  /** Purchase cost (par unless bought at a discount). */
  cost: number;
  purchaseYear: number;
  /** The tax year this holding funds — what the ladder's rungs count. For the engine's own gilts
   *  that is the year of the 6 April they redeem on; for a real gilt, the first tax year starting
   *  on or after its redemption date (`fundsYear`). */
  maturityYear: number;
  /** Real gilts only: ISIN. */
  isin?: string;
  /** Real gilts only: redemption date, ISO. */
  redemptionIso?: string;
  /** Real gilts only: accrued interest paid on purchase not yet set against a coupon (Accrued
   *  Income Scheme) — the next coupon is taxable only above it. */
  aisCredit?: number;
}

/** A real gilt (actual dates, market prices), as opposed to the engine's fictional par gilts. */
export function isRealGilt(g: GiltHolding): g is GiltHolding & { redemptionIso: string; isin: string } {
  return g.redemptionIso !== undefined;
}

/** When a holding redeems, ISO. */
export function redemptionOf(g: GiltHolding): string {
  return g.redemptionIso ?? `${g.maturityYear}-04-06`;
}

export interface SimState {
  balances: Record<PersonId, AccountState>;
  gilts: GiltHolding[];
  giltCounter: number;
}

/** The starting state. `opening` are real gilts held at the start (from the pre-retirement
 *  link); they are kept as themselves, while `balances[id].gilts` (only a total) is spread
 *  across the ladder's first rungs as the engine's own gilts. */
export function initState(scenario: Scenario, opening: OpeningGilt[] = []): SimState {
  const start = parseDate(scenario.startDate);
  const startYear = start.getUTCFullYear();
  const mk = (id: PersonId): AccountState => {
    const b = scenario.balances[id];
    return {
      isa: b.isa,
      pension: b.pension,
      gia: b.gia,
      savings: b.savings,
      premiumBonds: b.premiumBonds ?? 0,
      giaBasis: b.gia * (1 - b.giaGainFraction),
      lsaRemaining: Math.max(0, LUMP_SUM_ALLOWANCE - (scenario.people[id].lumpSumAllowanceUsed ?? 0)),
    };
  };
  // Opening gilts (only a total is known) are spread evenly across the ladder's rung years —
  // maturing at the start of each later year of the first buffer window — rather than all
  // forced to mature together.
  const firstYear = firstModelledTaxYear(scenario.startDate);
  const rungs = Math.max(
    1,
    Math.min(Math.ceil(scenario.strategy.bufferYears) - 1, Math.max(1, scenario.strategy.giltLadderYears)),
  );
  const gilts: GiltHolding[] = [];
  let giltCounter = 0;
  for (const id of ["nick", "tracy"] as PersonId[]) {
    const g = scenario.balances[id].gilts;
    if (g <= 0) continue;
    for (let k = 1; k <= rungs; k++) {
      const maturityYear = firstYear + k;
      gilts.push({
        id: `g${giltCounter++}`,
        holder: id,
        name: `G${maturityYear}`,
        nominal: g / rungs,
        couponRate: scenario.rates.giltCoupon,
        cost: g / rungs,
        purchaseYear: startYear,
        maturityYear,
      });
    }
  }
  for (const o of opening) {
    if (o.nominal <= 0 || o.redemptionDate <= scenario.startDate) continue;
    gilts.push({
      id: `g${giltCounter++}`,
      holder: o.holder,
      name: o.name,
      nominal: o.nominal,
      couponRate: o.couponRate,
      cost: o.nominal,
      purchaseYear: startYear,
      maturityYear: fundsYear(o.redemptionDate),
      isin: o.isin,
      redemptionIso: o.redemptionDate,
      aisCredit: o.aisCredit,
    });
  }
  return { balances: { nick: mk("nick"), tracy: mk("tracy") }, gilts, giltCounter };
}

/** Σ nominal (redemption value) of the gilts held, optionally one person's. */
export function giltValue(state: SimState, holder?: PersonId): number {
  return state.gilts
    .filter((g) => (holder ? g.holder === holder : true))
    .reduce((s, g) => s + g.nominal, 0);
}

/** What one holding sells for per £100 nominal: the dirty price, and the accrued interest in it
 *  (taxable income for the seller under the Accrued Income Scheme). */
export type GiltSalePrice = (g: GiltHolding) => { dirty: number; accrued: number };

/** Sell gilts to raise up to `amount` of a person's cash, nearest redemption first — used when
 *  cash runs out before the year-end refill. Gilts are CGT-exempt, so there is no gain to
 *  report; real gilts sell at `price` (their accrued interest is taxable income), the engine's
 *  own at par. Returns the cash raised and the accrued interest in it. */
export function sellGilts(
  state: SimState,
  holder: PersonId,
  amount: number,
  price?: GiltSalePrice,
): { proceeds: number; accruedIncome: number } {
  let remaining = amount;
  let accruedIncome = 0;
  const mine = state.gilts
    .filter((g) => g.holder === holder)
    .sort((a, b) => (redemptionOf(a) < redemptionOf(b) ? -1 : redemptionOf(a) > redemptionOf(b) ? 1 : 0));
  for (const g of mine) {
    if (remaining <= 0.005) break;
    if (!isRealGilt(g) || !price) {
      // At par: nominal in, the same cash out.
      const take = Math.min(remaining, g.nominal);
      g.cost -= g.cost * (take / g.nominal);
      g.nominal -= take;
      remaining -= take;
      continue;
    }
    const { dirty, accrued } = price(g);
    if (!(dirty > 0)) continue;
    const nominal = Math.min(g.nominal, (remaining * 100) / dirty);
    const share = nominal / g.nominal;
    g.cost -= g.cost * share;
    if (g.aisCredit) g.aisCredit -= g.aisCredit * share;
    g.nominal -= nominal;
    remaining -= (nominal * dirty) / 100;
    accruedIncome += (nominal * accrued) / 100;
  }
  state.gilts = state.gilts.filter((g) => g.nominal > 0.005);
  return { proceeds: amount - remaining, accruedIncome };
}

/** The GIA's embedded gain as a fraction of its value (proportional cost method), i.e. the
 *  share of any sale that is gain. 0 for an empty pot; never negative (a loss sells at 0 gain
 *  for planning — the realised figure from sellGia still carries the loss). */
export function giaGainFraction(acc: AccountState): number {
  if (acc.gia <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - acc.giaBasis / acc.gia));
}

/** Sell `amount` of GIA for a person; returns realised gain using proportional cost. */
export function sellGia(acc: AccountState, amount: number): { gain: number } {
  const sell = Math.min(amount, acc.gia);
  if (sell <= 0 || acc.gia <= 0) return { gain: 0 };
  const basisSold = acc.giaBasis * (sell / acc.gia);
  acc.gia -= sell;
  acc.giaBasis -= basisSold;
  return { gain: sell - basisSold };
}
