import { describe, expect, it } from "vitest";
import type { InvestmentAccount, PreRetirementData } from "../model/preRetirementTypes";
import type { GiltLot } from "../gilts/types";
import { buildPricing } from "../gilts/pricing";
import { accruedPer100, monthEnd } from "../gilts/schedule";
import { neededPriceDates, missingPriceDates } from "../gilts/market";
import { lotsValue, openingGiltsAt } from "../preretirement/giltAccounts";
import { latestActualTotal, projectAccounts, sampleAtDate, type KindRates } from "../preretirement/project";
import { handoffBalances, resolveScenarioForRun } from "../preretirement/link";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { syntheticMarket } from "./helpers/giltMarket";

// Pre-retirement gilt accounts holding real gilts (synthetic gilts, prices and balances only).

const RATES: KindRates = { isa: 0.07, pension: 0.07, gia: 0.07, savings: 0.035, premiumBonds: 0.04, gilts: 0 };
const market = syntheticMarket();
const pricing = buildPricing(market);

function giltAccount(partial: Partial<InvestmentAccount> = {}): InvestmentAccount {
  return {
    id: "g1",
    name: "Test Gilts",
    owner: "nick",
    kind: "gilts",
    openingBalance: 5_000,
    openingGainFraction: null,
    reliefAtSource: false,
    externalMonthlyContribution: 0,
    maturityYear: null,
    giltPayout: "account",
    ...partial,
  };
}

/** ⅛% 2028 (coupons 31 Jan/Jul) held before the opening month; 4% 2029 (7 Jun/Dec) bought in
 *  December 2026. */
const L1: GiltLot = {
  id: "l1",
  accountId: "g1",
  isin: "GB00TEST0002",
  name: "0.125% Test Gilt 2028",
  couponRate: 0.00125,
  redemptionDate: "2028-07-31",
  nominal: 10_000,
  purchaseDate: "2026-09-15",
  purchaseCleanPrice: 94,
};
const L2: GiltLot = {
  id: "l2",
  accountId: "g1",
  isin: "GB00TEST0003",
  name: "4% Test Gilt 2029",
  couponRate: 0.04,
  redemptionDate: "2029-06-07",
  nominal: 8_000,
  purchaseDate: "2026-12-10",
  purchaseCleanPrice: 97.5,
};

function data(lots: GiltLot[] = [L1, L2], account = giltAccount()): PreRetirementData {
  return { openingMonth: "2026-11", accounts: [account], overrides: [], giltLots: lots };
}

const project = (d: PreRetirementData, end = "2029-12", p = pricing) => projectAccounts(d, [], RATES, end, undefined, p);
const month = (r: ReturnType<typeof project>, key: string) => r.months.find((m) => m.key === key)!;

describe("a gilt account holding real gilts", () => {
  it("opens with its cash plus the gilts held at market value", () => {
    const r = project(data());
    expect(month(r, "2026-11").byAccount.g1.start).toBeCloseTo(5_000 + lotsValue([L1], "2026-10-31", pricing), 6);
  });

  it("pays for a purchase at the clean price plus accrued interest", () => {
    const r = project(data());
    const cost = (8_000 * (97.5 + accruedPer100(L2, "2026-12-10"))) / 100;
    expect(month(r, "2026-12").giltCash.g1).toBeCloseTo(5_000 - cost, 6);
  });

  it("keeps coupons and redemptions as cash in the account", () => {
    const r = project(data());
    const dec = month(r, "2026-12").giltCash.g1;
    // ⅛% on 10,000 every 31 Jan / 31 Jul: 6.25.
    expect(month(r, "2027-01").giltCash.g1 - dec).toBeCloseTo(6.25, 6);
    // 4% on 8,000 on 7 June: 160.
    expect(month(r, "2027-06").giltCash.g1 - month(r, "2027-05").giltCash.g1).toBeCloseTo(160, 6);
    // July 2028: the last ⅛% coupon and the 10,000 redemption.
    expect(month(r, "2028-07").giltCash.g1 - month(r, "2028-06").giltCash.g1).toBeCloseTo(10_006.25, 6);
  });

  it("or pays them out (external), as withdrawals from the account", () => {
    const r = project(data([L1, L2], giltAccount({ giltPayout: "external" })));
    expect(month(r, "2027-01").giltCash.g1).toBeCloseTo(month(r, "2026-12").giltCash.g1, 9);
    expect(month(r, "2027-01").byAccount.g1.withdrawals).toBeCloseTo(6.25, 6);
    expect(month(r, "2028-07").byAccount.g1.withdrawals).toBeCloseTo(10_006.25, 6);
  });

  it("gets no coupon for a purchase made ex-dividend, and pays negative accrued for it", () => {
    // 31 Jan 2027 coupon: ex-dividend from 21 Jan. Bought on the 25th → no coupon this time.
    const L3: GiltLot = { ...L1, id: "l3", purchaseDate: "2027-01-25", purchaseCleanPrice: 95 };
    const r = project(data([L3]));
    const cost = (10_000 * (95 + accruedPer100(L3, "2027-01-25", false))) / 100;
    expect(accruedPer100(L3, "2027-01-25", false)).toBeLessThan(0);
    expect(month(r, "2027-01").giltCash.g1).toBeCloseTo(5_000 - cost, 6);
    expect(month(r, "2027-07").giltCash.g1 - month(r, "2027-06").giltCash.g1).toBeCloseTo(6.25, 6);
  });

  it("keeps every month's invariant: end = (recorded ?? start) + growth + contributions − withdrawals", () => {
    const d = data();
    d.overrides = [{ accountId: "g1", monthKey: "2027-03", day: 15, value: 20_000, basis: null }];
    for (const m of project(d).months) {
      const c = m.byAccount.g1;
      expect(c.end, m.key).toBeCloseTo((c.recorded?.value ?? c.start) + c.growth + c.contributions - c.withdrawals, 6);
    }
  });

  it("re-anchors its cash on a recorded total balance", () => {
    const d = data();
    d.overrides = [{ accountId: "g1", monthKey: "2027-03", day: 15, value: 20_000, basis: null }];
    const r = project(d);
    // No flows between the 15th and the end of March.
    expect(month(r, "2027-03").giltCash.g1).toBeCloseTo(20_000 - lotsValue([L1, L2], "2027-03-15", pricing), 6);
  });

  it("samples a day consistently with the month ends", () => {
    const d = data();
    d.overrides = [{ accountId: "g1", monthKey: "2027-03", day: 15, value: 20_000, basis: null }];
    const r = project(d);
    for (const key of ["2026-11", "2026-12", "2027-01", "2027-03", "2028-07"]) {
      const s = sampleAtDate(r, d, [], RATES, monthEnd(key));
      expect(s.balances.g1, key).toBeCloseTo(month(r, key).byAccount.g1.end, 6);
      expect(s.giltCash.g1, key).toBeCloseTo(month(r, key).giltCash.g1, 6);
    }
    // At the recorded day itself the sample is the recorded value.
    expect(sampleAtDate(r, d, [], RATES, "2027-03-15").balances.g1).toBeCloseTo(20_000, 6);
  });

  it("values everything at par without market prices, with a warning", () => {
    const r = project(data(), "2027-06", buildPricing(null));
    expect(month(r, "2026-11").byAccount.g1.start).toBeCloseTo(5_000 + 10_000 + (10_000 * accruedPer100(L1, "2026-10-31")) / 100, 6);
    expect(r.warnings.some((w) => w.includes("valued at par"))).toBe(true);
  });

  it("warns when the opening balance looks like it includes the gilts", () => {
    const value = lotsValue([L1], "2026-10-31", pricing);
    const r = project(data([L1], giltAccount({ openingBalance: Math.round(value) })));
    expect(r.warnings.some((w) => w.includes("cash only"))).toBe(true);
  });

  it("ignores a holding in an account that isn't a gilts account", () => {
    const r = project(data([L1], giltAccount({ kind: "savings" })));
    expect(r.warnings.some((w) => w.includes("isn't a gilts account"))).toBe(true);
  });
});

describe("the latest actual balance of a gilt account with holdings", () => {
  const asOf = market.asOf!;

  it("is its opening cash, less purchases since the opening month, plus the gilts at the latest prices", () => {
    // L1 was held before the opening month; L2 (bought in December) is after the as-of date.
    const before = latestActualTotal(data(), { pricing, dateIso: asOf });
    expect(before.total).toBeCloseTo(5_000 + lotsValue([L1], asOf, pricing), 6);
    expect(before.giltValuedCount).toBe(1);
    expect(before.latestDate).toBe(asOf);
    // Valued later, L2 has been bought out of the cash (which can't go below zero).
    const later = latestActualTotal(data(), { pricing, dateIso: "2027-01-15" });
    expect(later.total).toBeCloseTo(lotsValue([L1, L2], "2027-01-15", pricing), 6);
  });

  it("uses a recorded balance when there is one, and the opening balance without pricing", () => {
    const d = data();
    d.overrides = [{ accountId: "g1", monthKey: "2026-11", day: 20, value: 16_000, basis: null }];
    expect(latestActualTotal(d, { pricing, dateIso: asOf }).total).toBe(16_000);
    expect(latestActualTotal(data()).total).toBe(5_000);
  });
});

describe("handing real gilts over to the retirement forecast", () => {
  it("aggregates the lots held by owner and gilt, with the accrued-income credit", () => {
    const lots = [L1, L2, { ...L2, id: "l2b", nominal: 2_000 }];
    const g = openingGiltsAt(data(lots), [giltAccount()], "2027-03-31");
    expect(g.map((x) => [x.isin, x.nominal])).toEqual([
      ["GB00TEST0002", 10_000],
      ["GB00TEST0003", 10_000],
    ]);
    // L2's first coupon (7 Jun 2027) is still to come: its accrued interest is a credit.
    expect(g[1].aisCredit).toBeCloseTo((10_000 * accruedPer100(L2, "2026-12-10")) / 100, 6);
    // L1 already had a coupon (31 Jan 2027): no credit.
    expect(g[0].aisCredit).toBe(0);
    // After redemption a lot isn't handed over.
    expect(openingGiltsAt(data(lots), [giltAccount()], "2028-08-01").map((x) => x.isin)).toEqual(["GB00TEST0003"]);
  });

  it("hands the cash over as savings and the gilts as themselves", () => {
    const d = data([L1, L2], giltAccount({ openingBalance: 15_000 }));
    const r = project(d, "2027-03");
    const s = sampleAtDate(r, d, [], RATES, "2027-03-31");
    const h = handoffBalances(r, s)!;
    expect(s.giltCash.g1).toBeGreaterThan(0);
    expect(h.balances.nick.savings).toBeCloseTo(s.giltCash.g1, 6);
    expect(h.balances.nick.gilts).toBe(0);
  });

  it("clamps an overspent gilt account's cash to zero at the handoff, with a warning", () => {
    const d = data(); // 5,000 of cash buys 8,000 of the 4% 2029
    const r = project(d, "2027-03");
    const h = handoffBalances(r, sampleAtDate(r, d, [], RATES, "2027-03-31"))!;
    expect(h.balances.nick.savings).toBe(0);
    expect(h.warnings.some((w) => w.includes("savings pot"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("cash goes below zero"))).toBe(true);
  });

  it("feeds a linked scenario's run context", () => {
    const sc = { ...defaultScenario(), linkPreRetirement: true };
    const d = data();
    const run = resolveScenarioForRun(sc, d, [], undefined, market);
    expect(run.ctx.giltMarket).toBe(market);
    // Both still held at the 5 April 2028 start (the ⅛% 2028 redeems in July).
    expect(run.ctx.openingGilts!.map((g) => g.isin)).toEqual(["GB00TEST0002", "GB00TEST0003"]);
    expect(run.scenario.balances.nick.gilts).toBe(0);
  });
});

describe("price dates the held gilts need", () => {
  it("lists the opening eve, month ends, purchases and records up to today", () => {
    const d = data();
    d.overrides = [{ accountId: "g1", monthKey: "2027-01", day: 20, value: 15_000, basis: null }];
    const { isins, dates } = neededPriceDates(d, "2027-02-10");
    expect(isins).toEqual(["GB00TEST0002", "GB00TEST0003"]);
    expect(dates).toEqual(["2026-09-15", "2026-10-31", "2026-11-30", "2026-12-10", "2026-12-31", "2027-01-20", "2027-01-31"]);
  });

  it("reports the dates the market has no prices near", () => {
    const missing = missingPriceDates(market, data(), "2027-02-10");
    // The synthetic market only has prices on 30 Oct 2026 (covering the 31 Oct eve).
    expect(missing).toContain("2026-12-31");
    expect(missing).not.toContain("2026-10-31");
  });
});

describe("a linked forecast with real gilts", () => {
  it("runs and reconciles", () => {
    const sc = { ...defaultScenario(), linkPreRetirement: true };
    const run = resolveScenarioForRun(sc, data(), [], undefined, market);
    const r = simulate(run.scenario, run.ctx);
    expect(r.gilts.some((g) => g.isin === "GB00TEST0003")).toBe(true);
  });
});
