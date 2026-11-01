import type { PersonId, Scenario } from "../model/types";
import { parseDate } from "../tax/taxYear";
import { LUMP_SUM_ALLOWANCE } from "../tax/pensionDraw";

export interface AccountState {
  isa: number;
  pension: number;
  gia: number;
  savings: number;
  /** Cost basis of the GIA holding, for CGT on disposals (proportional cost method). */
  giaBasis: number;
  /** Lump Sum Allowance still available: pension draws are 25% tax-free only while it lasts. */
  lsaRemaining: number;
}

export interface GiltHolding {
  id: string;
  holder: PersonId;
  /** Display name / rung, e.g. "T30" or "G2038". */
  name: string;
  nominal: number;
  couponRate: number;
  /** Purchase cost (par unless bought at a discount). */
  cost: number;
  purchaseYear: number;
  maturityYear: number;
}

export interface SimState {
  balances: Record<PersonId, AccountState>;
  gilts: GiltHolding[];
  giltCounter: number;
}

export function initState(scenario: Scenario): SimState {
  const start = parseDate(scenario.startDate);
  const startYear = start.getUTCFullYear();
  const mk = (id: PersonId): AccountState => {
    const b = scenario.balances[id];
    return {
      isa: b.isa,
      pension: b.pension,
      gia: b.gia,
      savings: b.savings,
      giaBasis: b.gia * (1 - b.giaGainFraction),
      lsaRemaining: Math.max(0, LUMP_SUM_ALLOWANCE - (scenario.people[id].lumpSumAllowanceUsed ?? 0)),
    };
  };
  const gilts: GiltHolding[] = [];
  let giltCounter = 0;
  for (const id of ["nick", "tracy"] as PersonId[]) {
    const g = scenario.balances[id].gilts;
    if (g > 0) {
      gilts.push({
        id: `g${giltCounter++}`,
        holder: id,
        name: "T30",
        nominal: g,
        couponRate: scenario.rates.giltCoupon,
        cost: g,
        purchaseYear: startYear,
        maturityYear: startYear + 3,
      });
    }
  }
  return { balances: { nick: mk("nick"), tracy: mk("tracy") }, gilts, giltCounter };
}

export function giltValue(state: SimState, holder?: PersonId): number {
  return state.gilts
    .filter((g) => (holder ? g.holder === holder : true))
    .reduce((s, g) => s + g.nominal, 0);
}

/** Sell up to `amount` (at par) of a person's gilts, nearest maturity first — used when cash
 *  runs out before the year-end refill. Gilts are CGT-exempt, so there is no gain to report.
 *  Returns the amount actually sold. */
export function sellGilts(state: SimState, holder: PersonId, amount: number): number {
  let remaining = amount;
  const mine = state.gilts
    .filter((g) => g.holder === holder)
    .sort((a, b) => a.maturityYear - b.maturityYear);
  for (const g of mine) {
    if (remaining <= 0.005) break;
    const take = Math.min(remaining, g.nominal);
    g.cost -= g.cost * (take / g.nominal);
    g.nominal -= take;
    remaining -= take;
  }
  state.gilts = state.gilts.filter((g) => g.nominal > 0.005);
  return amount - remaining;
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
