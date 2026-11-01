import { cleanFromYield } from "../../gilts/pricing";
import { yearsBetween } from "../../gilts/schedule";
import type { GiltInstrument, GiltMarket, GiltPrice } from "../../gilts/types";

/**
 * A synthetic gilt market for tests — made-up ISINs, names and prices (never real DMO data).
 * Near-par gilts sit on a gently rising curve (4.5% + 0.02% a year of term); low-coupon gilts
 * trade 0.15% richer, as real ones do for their tax advantage.
 */
export const SYNTHETIC_AS_OF = "2026-10-30";

const SPECS: { isin: string; coupon: number; redemption: string }[] = [
  { isin: "GB00TEST0001", coupon: 0.045, redemption: "2028-03-07" },
  { isin: "GB00TEST0002", coupon: 0.00125, redemption: "2028-07-31" },
  { isin: "GB00TEST0003", coupon: 0.04, redemption: "2029-06-07" },
  { isin: "GB00TEST0004", coupon: 0.005, redemption: "2030-01-31" },
  { isin: "GB00TEST0005", coupon: 0.0425, redemption: "2031-03-07" },
  { isin: "GB00TEST0006", coupon: 0.0025, redemption: "2031-07-31" },
  { isin: "GB00TEST0007", coupon: 0.045, redemption: "2033-09-07" },
  { isin: "GB00TEST0008", coupon: 0.04625, redemption: "2036-01-31" },
  { isin: "GB00TEST0009", coupon: 0.0475, redemption: "2041-06-07" },
  { isin: "GB00TEST0010", coupon: 0.0475, redemption: "2056-01-31" },
];

export function syntheticYield(term: number, coupon: number): number {
  return 0.045 + 0.0002 * term - (coupon < 0.02 ? 0.0015 : 0);
}

function fmtCoupon(c: number): string {
  return `${Math.round(c * 100000) / 1000}%`;
}

export function syntheticMarket(asOf = SYNTHETIC_AS_OF): GiltMarket {
  const instruments: GiltInstrument[] = SPECS.map((s) => ({
    isin: s.isin,
    name: `${fmtCoupon(s.coupon)} Test Gilt ${s.redemption.slice(0, 4)}`,
    couponRate: s.coupon,
    redemptionDate: s.redemption,
    indexLinked: false,
    rump: false,
  }));
  const prices: GiltPrice[] = instruments.map((i) => {
    const y = syntheticYield(yearsBetween(asOf, i.redemptionDate), i.couponRate);
    const sellClean = Math.round(cleanFromYield(i, asOf, y + 0.0002) * 100) / 100;
    const buyClean = Math.round(cleanFromYield(i, asOf, y - 0.0002) * 100) / 100;
    return { isin: i.isin, priceDate: asOf, buyClean, buyDirty: buyClean, sellClean, sellDirty: sellClean };
  });
  return { asOf, instruments, prices };
}
