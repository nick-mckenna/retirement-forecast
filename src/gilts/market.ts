import type { PreRetirementData } from "../model/preRetirementTypes";
import { addDays, monthEnd } from "./schedule";
import { buildPricing } from "./pricing";
import type { GiltMarket } from "./types";

/** The gilts held in pre-retirement accounts and the past dates their values are wanted for:
 *  the day before the opening month, every completed month end, each purchase date (to fill
 *  in the price paid) and each recorded balance of a gilt account with holdings. Only dates up
 *  to today — the DMO has nothing later. */
export function neededPriceDates(pre: PreRetirementData, todayIso: string): { isins: string[]; dates: string[] } {
  if (pre.giltLots.length === 0) return { isins: [], dates: [] };
  const isins = [...new Set(pre.giltLots.map((l) => l.isin))].sort();
  const dates = new Set<string>();
  const first = `${pre.openingMonth}-01`;
  dates.add(addDays(first, -1));
  let key = pre.openingMonth;
  for (let i = 0; i < 600; i++) {
    const end = monthEnd(key);
    if (end >= todayIso) break;
    dates.add(end);
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    key = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  for (const l of pre.giltLots) dates.add(l.purchaseDate);
  const lotAccounts = new Set(pre.giltLots.map((l) => l.accountId));
  for (const o of pre.overrides) {
    if (!lotAccounts.has(o.accountId)) continue;
    const end = monthEnd(o.monthKey);
    const day = o.day == null ? end : `${o.monthKey}-${String(o.day).padStart(2, "0")}`;
    dates.add(day > end ? end : day);
  }
  return { isins, dates: [...dates].filter((d) => d <= todayIso).sort() };
}

/** The needed dates that the market has no recorded price near (for any held ISIN). */
export function missingPriceDates(market: GiltMarket | null, pre: PreRetirementData, todayIso: string): string[] {
  const { isins, dates } = neededPriceDates(pre, todayIso);
  if (isins.length === 0) return [];
  if (!market || market.asOf === null) return dates;
  const pricing = buildPricing(market);
  // A date counts as covered when any held gilt still in issue then has a price near it.
  return dates.filter((d) =>
    !pre.giltLots.some((l) => l.purchaseDate <= d && l.redemptionDate > d && pricing.observed(l.isin, d, "sell") !== null) &&
    pre.giltLots.some((l) => l.redemptionDate > d),
  );
}
