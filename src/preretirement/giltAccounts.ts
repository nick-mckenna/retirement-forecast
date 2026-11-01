// Real gilts held in pre-retirement gilt accounts. Pure helpers shared by the monthly projection
// (project.ts), the day sampler and the retirement handoff (link.ts).
//
// A gilt account with holdings ("lots") is valued as its cash plus the lots at market prices:
//   - the account's opening balance is its CASH at the start of the opening month; lots bought
//     before then are held from the start (their cost was paid before the opening balance);
//   - a purchase costs nominal × (clean price + accrued interest) / 100 out of the cash;
//   - a coupon (half the annual rate, on the redemption day every six months) goes to whoever
//     held the lot when it went ex-dividend; the redemption repays the nominal;
//   - coupons and redemptions stay in the account's cash, or are paid out (giltPayout
//     "external" — e.g. to the joint account, recorded there as income);
//   - lots are valued at the DMO sale (bid) clean price plus accrued interest: the recorded
//     price on or shortly before the date, else modelled (see src/gilts/pricing.ts), else par.

import type { PersonId } from "../model/types";
import type { InvestmentAccount, PreRetirementData } from "../model/preRetirementTypes";
import type { GiltPricing } from "../gilts/pricing";
import type { GiltLot, OpeningGilt } from "../gilts/types";
import { accruedPer100, couponPer100, couponsBetween, entitledToNextCoupon, exDivDate, nextCoupon } from "../gilts/schedule";

/** Lots by account id (only for accounts of kind "gilts"). */
export function lotsByAccount(data: PreRetirementData, accounts: InvestmentAccount[]): Map<string, GiltLot[]> {
  const gilts = new Set(accounts.filter((a) => a.kind === "gilts").map((a) => a.id));
  const out = new Map<string, GiltLot[]>();
  for (const l of data.giltLots) {
    if (!gilts.has(l.accountId)) continue;
    const list = out.get(l.accountId) ?? [];
    list.push(l);
    out.set(l.accountId, list);
  }
  return out;
}

/** Held at the end of `iso`: bought on or before it and not yet redeemed. */
export function isHeld(lot: GiltLot, iso: string): boolean {
  return lot.purchaseDate <= iso && lot.redemptionDate > iso;
}

/** Clean price paid per £100: as entered, else the DMO buy price that day (modelled/par if
 *  unknown). */
export function lotCleanPaid(lot: GiltLot, pricing: GiltPricing): number {
  return lot.purchaseCleanPrice ?? pricing.clean(lot.isin, lot, lot.purchaseDate, "buy");
}

/** Accrued interest bought with the lot per £100 (negative when bought ex-dividend). */
export function lotAccruedPaid(lot: GiltLot): number {
  return accruedPer100(lot, lot.purchaseDate, entitledToNextCoupon(lot, lot.purchaseDate));
}

/** Cash paid for the lot: nominal × (clean + accrued) / 100. */
export function lotCost(lot: GiltLot, pricing: GiltPricing): number {
  return (lot.nominal * (lotCleanPaid(lot, pricing) + lotAccruedPaid(lot))) / 100;
}

/** Market value of the lots held at the end of `iso`: sale clean price plus accrued interest. */
export function lotsValue(lots: GiltLot[], iso: string, pricing: GiltPricing): number {
  let v = 0;
  for (const l of lots) {
    if (!isHeld(l, iso)) continue;
    v += (l.nominal * pricing.dirty(l.isin, l, iso, "sell")) / 100;
  }
  return v;
}

export interface GiltFlows {
  /** Cash spent on purchases. */
  purchases: number;
  /** Coupons and redemptions received. */
  income: number;
}

/** Purchases, coupons and redemptions dated in (fromExcl, toIncl]. A coupon is received only if
 *  the lot was bought before it went ex-dividend. */
export function giltFlowsBetween(lots: GiltLot[], fromExcl: string, toIncl: string, pricing: GiltPricing): GiltFlows {
  let purchases = 0;
  let income = 0;
  for (const l of lots) {
    if (l.purchaseDate > fromExcl && l.purchaseDate <= toIncl) purchases += lotCost(l, pricing);
    const from = fromExcl > l.purchaseDate ? fromExcl : l.purchaseDate;
    for (const c of couponsBetween(l, from, toIncl)) {
      if (l.purchaseDate < exDivDate(c)) income += (l.nominal * couponPer100(l)) / 100;
    }
    if (l.redemptionDate > fromExcl && l.redemptionDate <= toIncl && l.purchaseDate < l.redemptionDate) income += l.nominal;
  }
  return { purchases, income };
}

/** The real gilts held at the end of the handoff day, aggregated by owner and ISIN, for the
 *  retirement engine. The accrued interest paid on lots that haven't yet had their first coupon
 *  becomes an Accrued Income Scheme credit against it. */
export function openingGiltsAt(
  data: PreRetirementData,
  accounts: InvestmentAccount[],
  iso: string,
): OpeningGilt[] {
  const owner = new Map<string, PersonId>(accounts.map((a) => [a.id, a.owner]));
  const out = new Map<string, OpeningGilt>();
  for (const [accountId, lots] of lotsByAccount(data, accounts)) {
    for (const l of lots) {
      if (!isHeld(l, iso)) continue;
      const holder = owner.get(accountId)!;
      const key = `${holder}|${l.isin}`;
      const g = out.get(key) ?? {
        holder,
        isin: l.isin,
        name: l.name,
        couponRate: l.couponRate,
        redemptionDate: l.redemptionDate,
        nominal: 0,
        aisCredit: 0,
      };
      g.nominal += l.nominal;
      const first = nextCoupon(l, l.purchaseDate);
      if (first !== null && first > iso) g.aisCredit += Math.max(0, (l.nominal * lotAccruedPaid(l)) / 100);
      out.set(key, g);
    }
  }
  return [...out.values()].sort((a, b) =>
    a.holder === b.holder ? a.redemptionDate.localeCompare(b.redemptionDate) : a.holder.localeCompare(b.holder),
  );
}
