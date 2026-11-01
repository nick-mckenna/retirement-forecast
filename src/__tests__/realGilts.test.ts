import { describe, expect, it } from "vitest";
import type { LedgerRow, PersonColumns } from "../engine/ledger";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import type { Scenario, StrategyConfig } from "../model/types";
import { runForecast } from "../strategy/optimiser";
import type { OpeningGilt, SimContext } from "../gilts/types";
import { buildPricing } from "../gilts/pricing";
import { syntheticMarket } from "./helpers/giltMarket";

// Real gilts handed to the retirement engine (synthetic gilts and prices only).

const POTS: (keyof PersonColumns)[] = ["isa", "pension", "gia", "savings", "giltsTotal"];

function expectLedgerReconciles(rows: LedgerRow[]) {
  let prev: LedgerRow | null = null;
  let acc = { nick: {} as Record<string, number>, tracy: {} as Record<string, number> };
  for (const r of rows) {
    if (r.type === "TRANSACTION") {
      for (const id of ["nick", "tracy"] as const) for (const c of POTS) acc[id][c] = (acc[id][c] ?? 0) + r[id][c];
      continue;
    }
    if (prev) {
      for (const id of ["nick", "tracy"] as const)
        for (const c of POTS)
          expect(prev[id][c] + (acc[id][c] ?? 0), `${r.label} ${r.dateIso} ${id}.${c}`).toBeCloseTo(r[id][c], 4);
    }
    prev = r;
    acc = { nick: {}, tracy: {} };
  }
}

const market = syntheticMarket();

/** A 4% gilt maturing 7 June 2029 (coupons 7 Jun/Dec), a ¼% one maturing 31 July 2031 and a
 *  long 4¾% one (2056). */
const OPENING: OpeningGilt[] = [
  { holder: "nick", isin: "GB00TEST0003", name: "4% Test Gilt 2029", couponRate: 0.04, redemptionDate: "2029-06-07", nominal: 20_000, aisCredit: 150 },
  { holder: "nick", isin: "GB00TEST0006", name: "0.25% Test Gilt 2031", couponRate: 0.0025, redemptionDate: "2031-07-31", nominal: 30_000, aisCredit: 0 },
  { holder: "tracy", isin: "GB00TEST0010", name: "4.75% Test Gilt 2056", couponRate: 0.0475, redemptionDate: "2056-01-31", nominal: 10_000, aisCredit: 0 },
];

const ctx = (opening = OPENING): SimContext => ({ giltMarket: market, openingGilts: opening });

const MODES: StrategyConfig["taxMode"][] = ["heuristic", "annual", "lifetime"];

function scenarioFor(mode: StrategyConfig["taxMode"]): Scenario {
  const s = defaultScenario();
  s.strategy.taxMode = mode;
  if (mode === "lifetime") s.strategy.lifetimeFillFraction = 0.75;
  return s;
}

describe("without real gilts the engine is unchanged", () => {
  it("gives the same result with or without a market when buying fictional gilts", () => {
    const s = defaultScenario();
    const fictional = { ...s, strategy: { ...s.strategy, giltUniverse: "fictional" as const } };
    expect(simulate(fictional, { giltMarket: market })).toEqual(simulate(s));
    expect(simulate(s, {})).toEqual(simulate(s));
  });

  it("never books a revaluation for the engine's own (par) gilts", () => {
    expect(simulate(defaultScenario()).rows.some((r) => r.label === "Gilt revaluation")).toBe(false);
  });
});

describe.each(MODES)("real opening gilts (%s)", (mode) => {
  const result = simulate(scenarioFor(mode), ctx());

  it("reconciles the ledger", () => {
    expectLedgerReconciles(result.rows);
  });

  it("keeps the buffer at its target after tax", () => {
    for (const y of result.years) {
      expect(y.bufferEnd, `${y.taxYearStart}`).toBeGreaterThanOrEqual(y.bufferTargetValue - 1);
    }
  });

  it("reconciles with a mid-year start too", () => {
    const s = scenarioFor(mode);
    s.startDate = "2028-10-01";
    expectLedgerReconciles(simulate(s, ctx()).rows);
  });
});

describe("real gilt cash flows", () => {
  // The ladder buys the engine's own gilts here, so only the opening real gilts are real.
  const s = { ...defaultScenario(), strategy: { ...defaultScenario().strategy, giltUniverse: "fictional" as const } };
  const r = simulate(s, ctx());
  const row = (label: string, date: string) => r.rows.find((x) => x.label === label && x.dateIso === date);

  it("pays half the coupon on each coupon date", () => {
    expect(row("Gilt Coupon", "2028-06-07")!.nick.savings).toBeCloseTo(400, 6);
    expect(row("Gilt Coupon", "2028-12-07")!.nick.savings).toBeCloseTo(400, 6);
    // ¼% on 30,000: 37.50 every 31 Jan / 31 Jul.
    expect(row("Gilt Coupon", "2028-07-31")!.nick.savings).toBeCloseTo(37.5, 6);
    // 4¾% on 10,000: 237.50 every 31 Jan / 31 Jul.
    expect(row("Gilt Coupon", "2028-07-31")!.tracy.savings).toBeCloseTo(237.5, 6);
  });

  it("redeems at par on the redemption date", () => {
    const m = row("Gilt Maturity", "2029-06-07")!;
    expect(m.nick.savings).toBe(20_000);
    expect(m.nick.giltsTotal).toBe(-20_000);
    // …alongside the engine's own 7,500 rung redeeming on 6 April 2029.
    expect(r.years[1].disposals.giltMaturities.nick).toBe(20_000 + 7_500);
  });

  it("records the real gilts with their ISIN and redemption date", () => {
    const g = r.gilts.find((x) => x.isin === "GB00TEST0006")!;
    expect(g.maturityDateIso).toBe("2031-07-31");
    expect(g.initial).toBe(true);
  });

  it("relieves the first coupon by the accrued interest bought (Accrued Income Scheme)", () => {
    const noCredit = simulate(s, ctx(OPENING.map((g) => ({ ...g, aisCredit: 0 }))));
    expect(noCredit.years[0].tax.nick.savingsIncome - r.years[0].tax.nick.savingsIncome).toBeCloseTo(150, 1);
  });

  it("values them at market prices and revalues to keep the ledger whole", () => {
    expect(r.rows.some((x) => x.label === "Gilt revaluation")).toBe(true);
    const start = r.rows[0];
    // The long 4¾% gilt trades below par on a curve above its coupon.
    expect(start.tracy.giltsTotal).toBeLessThan(10_000);
    expect(start.tracy.giltsTotal).toBeGreaterThan(9_000);
  });
});

describe("the buffer counts real gilts by when they mature", () => {
  it("as the cash it will deliver inside the buffer window, at market value beyond it", () => {
    const s = defaultScenario();
    s.strategy.autoStrategy = false;
    const r = simulate(s, ctx());
    const end = "2029-04-05";
    const yearEnd = r.rows.find((x) => x.label === "Year End" && x.dateIso === end)!;
    const pricing = buildPricing(market);
    const mv = (g: OpeningGilt) => (g.nominal * pricing.dirty(g.isin, g, end, "sell")) / 100;
    const cash = yearEnd.nick.savings + yearEnd.tracy.savings;
    // The window after 2028/29 is 2029–2031. The 4% 2029 funds 2030: its nominal plus its last
    // coupon (7 June 2029). The ¼% 2031 funds 2032 and the 2056 gilt far later: market value.
    // The engine's own 15,000 of rungs: par.
    expect(r.years[0].bufferEnd).toBeCloseTo(cash + 15_000 + 20_400 + mv(OPENING[1]) + mv(OPENING[2]), 4);
    // The ledger's gilts column holds every real gilt at market value.
    expect(yearEnd.nick.giltsTotal).toBeCloseTo(15_000 + mv(OPENING[0]) + mv(OPENING[1]), 4);
    expect(yearEnd.tracy.giltsTotal).toBeCloseTo(mv(OPENING[2]), 4);
  });
});

describe("income drawn from real gilts when cash runs out", () => {
  it("sells them at the market price and taxes the accrued interest", () => {
    const s = defaultScenario();
    for (const id of ["nick", "tracy"] as const) {
      s.balances[id] = { ...s.balances[id], isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0 };
      s.finalIncome.perPerson[id] = { net: 0, tax: 0, employerPension: 0 };
    }
    const opening: OpeningGilt[] = [
      { holder: "nick", isin: "GB00TEST0005", name: "4.25% Test Gilt 2031", couponRate: 0.0425, redemptionDate: "2031-03-07", nominal: 300_000, aisCredit: 0 },
    ];
    const r = simulate(s, ctx(opening));
    expectLedgerReconciles(r.rows);
    expect(r.years[0].disposals.giltSales.nick).toBeGreaterThan(50_000);
    expect(r.warnings.some((w) => w.includes("2028/29 ("))).toBe(false);
    const coupons = r.rows
      .filter((x) => x.label === "Gilt Coupon" && x.dateIso < "2029-04-06")
      .reduce((t, x) => t + x.nick.savings, 0);
    // Taxable savings income = coupons + accrued interest sold (no cash, so no bank interest).
    expect(r.years[0].tax.nick.savingsIncome).toBeGreaterThan(coupons + 1);
  });
});

describe("runForecast passes the context through", () => {
  it("in every tax mode", () => {
    for (const mode of MODES) {
      const s = defaultScenario();
      s.strategy.taxMode = mode;
      const out = runForecast(s, ctx());
      expect(out.result.gilts.some((g) => g.isin === "GB00TEST0003")).toBe(true);
    }
  });
});
