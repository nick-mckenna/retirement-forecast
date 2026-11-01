import { describe, expect, it } from "vitest";
import type { LedgerRow, PersonColumns } from "../engine/ledger";
import { simulate } from "../engine/simulate";
import { initState } from "../engine/state";
import { defaultScenario } from "../model/defaults";
import type { GiltSelection, PersonId, Scenario, StrategyConfig } from "../model/types";
import { buildPricing } from "../gilts/pricing";
import { fundsYear } from "../gilts/schedule";
import type { GiltInstrument } from "../gilts/types";
import { chooseRealGilt, planGiltPurchases, type RealGiltMarket } from "../strategy/giltLadder";
import { statePensionForYear, statePensionGrowth } from "../tax/statePension";
import { syntheticMarket } from "./helpers/giltMarket";

// The ladder buying real gilts (synthetic gilts and prices only). In the synthetic market the
// tax year 2030 can be funded by a 4% gilt (7 Jun 2029) or a ½% one (31 Jan 2030); low-coupon
// gilts trade 0.15% richer, as real ones do; nothing redeems in time for 2033 alone.

const market = syntheticMarket();

function byFundsYear(): Map<number, GiltInstrument[]> {
  const out = new Map<number, GiltInstrument[]>();
  for (const i of market.instruments) {
    const list = out.get(fundsYear(i.redemptionDate)) ?? [];
    list.push(i);
    out.set(fundsYear(i.redemptionDate), list);
  }
  return out;
}

function realMarket(selection: GiltSelection, taxRate: Record<PersonId, number> = { nick: 0.4, tracy: 0.4 }): RealGiltMarket {
  return { pricing: buildPricing(market), byFundsYear: byFundsYear(), purchaseIso: "2029-04-05", selection, taxRate };
}

describe("choosing a real gilt for a rung", () => {
  it("lowest coupon picks the ½% gilt", () => {
    expect(chooseRealGilt(realMarket("lowestCoupon"), 2030, "nick")!.isin).toBe("GB00TEST0004");
  });

  it("best gross yield picks the 4% gilt", () => {
    expect(chooseRealGilt(realMarket("grossYield"), 2030, "nick")!.isin).toBe("GB00TEST0003");
  });

  it("best yield after tax depends on the holder's tax rate", () => {
    const m = realMarket("netYield", { nick: 0.4, tracy: 0 });
    const taxed = chooseRealGilt(m, 2030, "nick")!;
    const untaxed = chooseRealGilt(m, 2030, "tracy")!;
    expect(taxed.isin).toBe("GB00TEST0004");
    expect(untaxed.isin).toBe("GB00TEST0003");
    expect(taxed.netYield).toBeLessThan(taxed.grossYield);
    expect(untaxed.netYield).toBeCloseTo(untaxed.grossYield, 9);
  });

  it("finds nothing for a year no real gilt redeems in time for", () => {
    expect(chooseRealGilt(realMarket("netYield"), 2033, "nick")).toBeNull();
  });
});

describe("planning real gilt purchases", () => {
  const s = defaultScenario();
  s.strategy = { ...s.strategy, bufferYears: 6, giltLadderYears: 5 }; // rungs 2030–2034
  const next = 2029;
  const flat = () => 40_000;

  function plan(nickCash: number, tracyCash: number, m: RealGiltMarket) {
    const state = initState(s);
    state.gilts = [];
    state.balances.nick.savings = nickCash;
    state.balances.tracy.savings = tracyCash;
    return planGiltPurchases(state, flat, s.rates, s.strategy, next, { nick: 0, tracy: 0 }, m);
  }

  it("buys each rung's nominal, each holder their own preferred gilt", () => {
    const out = plan(500_000, 500_000, realMarket("netYield", { nick: 0.4, tracy: 0 }));
    const rung2030 = out.filter((p) => p.maturityYear === 2030);
    expect(rung2030.reduce((t, p) => t + p.nominal, 0)).toBeGreaterThan(40_000 - 2);
    expect(rung2030.find((p) => p.holder === "nick")!.real!.isin).toBe("GB00TEST0004");
    expect(rung2030.find((p) => p.holder === "tracy")!.real!.isin).toBe("GB00TEST0003");
  });

  it("fills a year with no real gilt with a fictional one issued at par on the curve", () => {
    const out = plan(500_000, 500_000, realMarket("netYield"));
    const rung2033 = out.filter((p) => p.maturityYear === 2033);
    expect(rung2033).toHaveLength(2);
    for (const p of rung2033) {
      expect(p.real).toBeUndefined();
      expect(p.cost).toBe(p.nominal);
      expect(p.couponRate).toBeGreaterThan(0.04);
      expect(p.couponRate).toBeLessThan(0.05);
    }
  });

  it("never spends more than each person's spare cash", () => {
    // 40,000 of next year's need is kept back (20,000 each); the rest is spare.
    const out = plan(35_000, 80_000, realMarket("netYield"));
    const spent = (h: PersonId) => out.filter((p) => p.holder === h).reduce((t, p) => t + p.cost, 0);
    expect(spent("nick")).toBeLessThanOrEqual(15_000 + 1e-6);
    expect(spent("tracy")).toBeLessThanOrEqual(60_000 + 1e-6);
    expect(spent("nick") + spent("tracy")).toBeGreaterThan(74_000);
    for (const p of out) if (p.real) expect(p.cost).toBeCloseTo((p.nominal * p.real.dirty) / 100, 6);
  });
});

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

const MODES: StrategyConfig["taxMode"][] = ["heuristic", "annual", "lifetime"];

function scenarioFor(mode: StrategyConfig["taxMode"], selection: GiltSelection = "netYield"): Scenario {
  const s = defaultScenario();
  s.strategy.taxMode = mode;
  s.strategy.giltSelection = selection;
  if (mode === "lifetime") s.strategy.lifetimeFillFraction = 0.75;
  return s;
}

describe.each(MODES)("the engine buying real gilts (%s)", (mode) => {
  const s = scenarioFor(mode);
  const result = simulate(s, { giltMarket: market });
  const yearEnds = result.rows.filter((r) => r.type === "BALANCE" && r.label === "Year End");

  it("buys real gilts, recorded with their price and yields", () => {
    const bought = result.gilts.filter((g) => !g.initial && g.isin);
    expect(bought.length).toBeGreaterThan(0);
    for (const g of bought) {
      expect(g.cleanPrice).toBeGreaterThan(80);
      expect(g.cost).toBeGreaterThan(0);
      expect(g.grossYield).toBeGreaterThan(0.03);
    }
  });

  it("reconciles the ledger", () => {
    expectLedgerReconciles(result.rows);
  });

  it("keeps the buffer at its target after tax", () => {
    for (const y of result.years) {
      expect(y.bufferEnd, `${y.taxYearStart}`).toBeGreaterThanOrEqual(y.bufferTargetValue - 1);
    }
  });

  it("keeps next year's net need in cash (plus gilts redeeming on its 6 April)", () => {
    const growth = statePensionGrowth(s.rates);
    for (let i = 0; i < result.years.length - 1; i++) {
      const next = result.years[i + 1].taxYearStart;
      const cash = yearEnds[i].nick.savings + yearEnds[i].tracy.savings;
      const maturing = result.gilts
        .filter((g) => g.maturityDateIso === `${next}-04-06` && g.purchaseDateIso <= yearEnds[i].dateIso)
        .reduce((t, g) => t + g.nominal, 0);
      const need = Math.max(
        0,
        result.years[i + 1].incomeTarget -
          statePensionForYear(s.people.nick, next, s.income.startYear, growth) -
          statePensionForYear(s.people.tracy, next, s.income.startYear, growth),
      );
      expect(cash + maturing, `${result.years[i].taxYearStart}/${next}`).toBeGreaterThanOrEqual(need - 1);
    }
  });
});

describe("what the ladder buys follows the settings", () => {
  const isins = (s: Scenario) =>
    new Set(simulate(s, { giltMarket: market }).gilts.filter((g) => !g.initial && g.isin).map((g) => g.isin));

  it("lowest coupon and best gross yield choose differently", () => {
    const low = isins(scenarioFor("heuristic", "lowestCoupon"));
    const gross = isins(scenarioFor("heuristic", "grossYield"));
    expect([...low].sort()).not.toEqual([...gross].sort());
    expect(low.has("GB00TEST0004")).toBe(true);
    expect(gross.has("GB00TEST0003")).toBe(true);
  });

  it("a positive yield shift buys the same gilts cheaper", () => {
    const base = simulate(scenarioFor("heuristic"), { giltMarket: market }).gilts.find((g) => !g.initial && g.isin)!;
    const s = scenarioFor("heuristic");
    s.rates.giltYieldShift = 0.01;
    const shifted = simulate(s, { giltMarket: market }).gilts.find((g) => !g.initial && g.isin === base.isin)!;
    expect(shifted.cleanPrice!).toBeLessThan(base.cleanPrice!);
  });

  it("buys fictional gilts, with a warning, when the market has no prices yet", () => {
    const r = simulate(defaultScenario(), { giltMarket: null });
    expect(r.gilts.every((g) => !g.isin)).toBe(true);
    expect(r.warnings.some((w) => w.includes("No DMO gilt prices yet"))).toBe(true);
    // …and identical to the legacy run otherwise.
    expect(r.rows).toEqual(simulate(defaultScenario()).rows);
  });

  it("ranks the first purchases without the one-off final salary in the tax rate", () => {
    // The sample's final salary (100,000 gross in 2028/29) is in the allowance taper; the coupons
    // of gilts bought at that year end fall in later years without it.
    const r = simulate(scenarioFor("heuristic"), { giltMarket: market });
    const first = r.gilts.filter((g) => !g.initial && g.isin && g.purchaseDateIso === "2029-04-05");
    expect(first.length).toBeGreaterThan(0);
    for (const g of first) expect(g.taxRate!).toBeLessThan(0.45);
  });

  it("labels the purchase row with the real gilts bought", () => {
    const r = simulate(scenarioFor("heuristic"), { giltMarket: market });
    const row = r.rows.find((x) => x.label.startsWith("Gilt Purchase (") && x.label.includes("Test Gilt"));
    expect(row).toBeDefined();
    expect(row!.label).toMatch(/Test Gilt \d{4}, matures \d{2}\/\d{2}\/\d{4}/);
  });
});
