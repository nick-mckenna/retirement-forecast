import {
  buildPricing,
  cleanFromYield,
  curveAt,
  dirtyFromYield,
  fitCurve,
  yieldFromClean,
  yieldFromDirty,
} from "../gilts/pricing";
import { accruedPer100 } from "../gilts/schedule";
import type { GiltMarket, GiltTerms } from "../gilts/types";
import { syntheticMarket } from "./helpers/giltMarket";

const g31: GiltTerms = { couponRate: 0.01, redemptionDate: "2031-07-22" };
const par5: GiltTerms = { couponRate: 0.05, redemptionDate: "2036-03-07" };

describe("gilt price ↔ yield", () => {
  it("round-trips", () => {
    for (const y of [-0.002, 0.01, 0.0437, 0.09]) {
      const p = dirtyFromYield(g31, "2026-11-04", y);
      expect(yieldFromDirty(g31, "2026-11-04", p)).toBeCloseTo(y, 9);
    }
  });

  it("prices a gilt whose coupon equals the yield at par on a coupon date", () => {
    expect(cleanFromYield(par5, "2026-09-07", 0.05)).toBeCloseTo(100, 8);
  });

  it("matches a hand-computed price: one coupon and redemption left", () => {
    // From the last-but-one coupon (2031-01-22) the flows are 0.5 + 100 in one period.
    expect(dirtyFromYield(g31, "2031-01-22", 0.04)).toBeCloseTo(100.5 / 1.02, 9);
  });

  it("pulls to par towards redemption", () => {
    const early = cleanFromYield(g31, "2027-01-22", 0.045);
    const late = cleanFromYield(g31, "2031-01-22", 0.045);
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(100);
    expect(cleanFromYield(g31, "2031-07-22", 0.045)).toBe(100);
  });

  it("gives (almost) the same yield whether the clean price is taken cum or ex dividend", () => {
    const clean = 92;
    const iso = "2027-01-15"; // ex-dividend for the 2027-01-22 coupon
    const ex = yieldFromDirty(g31, iso, clean + accruedPer100(g31, iso, false), false);
    expect(Math.abs(yieldFromClean(g31, iso, clean) - ex)).toBeLessThan(0.0005);
  });
});

describe("yield curve", () => {
  it("interpolates between knots and is flat beyond the ends", () => {
    const c = fitCurve([
      { term: 1, y: 0.04 },
      { term: 10, y: 0.05 },
    ]);
    const short = curveAt(c, 0.01)!;
    const long = curveAt(c, 80)!;
    expect(short).toBeCloseTo(curveAt(c, 0.25)!, 12);
    expect(long).toBeCloseTo(curveAt(c, 50)!, 12);
    expect(curveAt(c, 5)!).toBeGreaterThan(short);
    expect(curveAt(c, 5)!).toBeLessThan(long);
  });
});

describe("market pricing", () => {
  const market: GiltMarket = syntheticMarket();

  it("reproduces the observed prices on the as-of date", () => {
    const pricing = buildPricing(market);
    for (const p of market.prices) {
      const inst = market.instruments.find((i) => i.isin === p.isin)!;
      expect(pricing.clean(p.isin, inst, p.priceDate, "buy")).toBe(p.buyClean);
      expect(pricing.clean(p.isin, inst, p.priceDate, "sell")).toBe(p.sellClean);
    }
  });

  it("models a later date close to today's yield for the same gilt", () => {
    const pricing = buildPricing(market);
    const inst = market.instruments[0];
    const today = pricing.yieldOf(inst.isin, "sell")!;
    const later = pricing.clean(inst.isin, inst, "2027-06-01", "sell");
    // The curve is nearly flat in the synthetic market, so the yield barely moves.
    expect(yieldFromClean(inst, "2027-06-01", later)).toBeCloseTo(today, 2);
  });

  it("shifts future prices with the yield shift", () => {
    const inst = market.instruments[0];
    const base = buildPricing(market, 0).clean(inst.isin, inst, "2028-01-01", "buy");
    const up = buildPricing(market, 0.01).clean(inst.isin, inst, "2028-01-01", "buy");
    expect(up).toBeLessThan(base);
  });

  it("memoises per market and shift", () => {
    expect(buildPricing(market, 0)).toBe(buildPricing(market, 0));
    expect(buildPricing(market, 0)).not.toBe(buildPricing(market, 0.01));
  });

  it("values everything at par without a market", () => {
    const pricing = buildPricing(null);
    expect(pricing.hasMarket).toBe(false);
    expect(pricing.clean("GB00TEST0001", g31, "2028-01-01", "sell")).toBe(100);
    const empty = buildPricing({ asOf: null, instruments: [], prices: [] });
    expect(empty.clean("GB00TEST0001", g31, "2028-01-01", "sell")).toBe(100);
  });

  it("prices an unknown ISIN on the curve", () => {
    const pricing = buildPricing(market);
    const clean = pricing.clean("GB00UNKNOWN9", g31, "2027-01-22", "sell");
    const y = pricing.curveYield(4.5)!;
    expect(clean).toBeCloseTo(cleanFromYield(g31, "2027-01-22", y), 1);
  });
});
