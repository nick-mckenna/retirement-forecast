import type { PersonId, Scenario } from "../model/types";
import { parseDate } from "../tax/taxYear";

export interface AccountState {
  isa: number;
  pension: number;
  gia: number;
  savings: number;
  /** Cost basis of the GIA holding, for CGT on disposals (proportional cost method). */
  giaBasis: number;
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

/** Sell `amount` of GIA for a person; returns realised gain using proportional cost. */
export function sellGia(acc: AccountState, amount: number): { gain: number } {
  const sell = Math.min(amount, acc.gia);
  if (sell <= 0 || acc.gia <= 0) return { gain: 0 };
  const basisSold = acc.giaBasis * (sell / acc.gia);
  acc.gia -= sell;
  acc.giaBasis -= basisSold;
  return { gain: sell - basisSold };
}
