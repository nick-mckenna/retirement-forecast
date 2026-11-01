import { describe, expect, it } from "vitest";
import { simulate } from "../engine/simulate";
import { initState } from "../engine/state";
import { defaultScenario } from "../model/defaults";
import { resolveIncome, targetForYear } from "../model/incomeTargets";
import type { Scenario, StrategyConfig } from "../model/types";
import { planGiltPurchases } from "../strategy/giltLadder";
import { bufferTarget } from "../strategy/buffer";
import { statePensionForYear, statePensionGrowth } from "../tax/statePension";

// The year-end refill must leave the cash + gilts buffer at its target *after* the year's tax
// has been paid out of it. Before this was provisioned for, the buffer finished every year
// short by exactly the tax bill, so cash could run out in the months before the next refill.

const MODES: StrategyConfig["taxMode"][] = ["heuristic", "annual", "lifetime"];

function scenarioFor(mode: StrategyConfig["taxMode"]): Scenario {
  const s = defaultScenario();
  s.strategy.taxMode = mode;
  // Lifetime mode only crystallises when given a fill level (runForecast searches these).
  if (mode === "lifetime") s.strategy.lifetimeFillFraction = 0.75;
  return s;
}

describe.each(MODES)("year-end refill provisions for the tax bill (%s)", (mode) => {
  const result = simulate(scenarioFor(mode));
  const yearEnds = result.rows.filter((r) => r.type === "BALANCE" && r.label === "Year End");

  it("ends every tax year with the buffer at (or above) its target, after tax", () => {
    for (const y of result.years) {
      expect(y.bufferEnd, `${y.taxYearStart}/${y.taxYearStart + 1}`).toBeGreaterThanOrEqual(
        y.bufferTargetValue - 1,
      );
    }
  });

  it("keeps next year's net need as cash plus gilts maturing on its 6 April, after tax", () => {
    const s = scenarioFor(mode);
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

  it("never leaves either person's cash overdrawn at year end while the household has cash", () => {
    for (const r of yearEnds) {
      expect(Math.min(r.nick.savings, r.tracy.savings), r.dateIso).toBeGreaterThanOrEqual(-0.01);
    }
  });
});

describe.each(["heuristic", "annual"] as const)("refill sizing is tight (%s)", (mode) => {
  const result = simulate(scenarioFor(mode));

  it("sells only enough to land the buffer on target once tax is paid", () => {
    let refills = 0;
    for (const y of result.years) {
      const refilled = result.rows.some(
        (r) => r.label === "Refill: sell investments" && r.dateIso === `${y.taxYearStart + 1}-04-05`,
      );
      if (!refilled) continue;
      refills++;
      expect(y.bufferEnd, `${y.taxYearStart}/${y.taxYearStart + 1}`).toBeCloseTo(y.bufferTargetValue, 0);
    }
    expect(refills).toBeGreaterThan(10);
  });
});

describe("gilt ladder", () => {
  // Synthetic: no gilts held; each person's cash is set per test.
  const s = defaultScenario();
  const income = resolveIncome(s);
  const next = income.startYear + 1;
  const oneYear = targetForYear(income, next);
  const plan = (nickCash: number, tracyCash: number, reserved = { nick: 0, tracy: 0 }) => {
    const state = initState(s);
    state.gilts = [];
    state.balances.nick.savings = nickCash;
    state.balances.tracy.savings = tracyCash;
    const out = planGiltPurchases(state, (y) => targetForYear(income, y), s.rates, s.strategy, next, reserved);
    const of = (id: "nick" | "tracy") => out.filter((g) => g.holder === id).reduce((t, g) => t + g.nominal, 0);
    return { nick: of("nick"), tracy: of("tracy"), total: of("nick") + of("tracy") };
  };

  it("invests only the household cash above the floor that isn't reserved for tax", () => {
    const each = oneYear / 2 + 15000; // £30,000 spare in total
    expect(plan(each, each).total).toBeCloseTo(30000, -1);
    expect(plan(each, each, { nick: 10000, tracy: 10000 }).total).toBeCloseTo(10000, -1);
    expect(plan(each, each, { nick: 15000, tracy: 15000 }).total).toBe(0);
  });

  it("splits a rung half each when both people can afford it", () => {
    const p = plan(oneYear / 2 + 15000, oneYear / 2 + 15000);
    expect(p.nick).toBeCloseTo(15000, -1);
    expect(p.tracy).toBeCloseTo(15000, -1);
  });

  it("buys a person's share only from their own spare cash, after their tax", () => {
    // Nick has £5,000 above his half of the floor but owes £8,000 tax; Tracy has plenty.
    const p = plan(oneYear / 2 + 5000, oneYear / 2 + 60000, { nick: 8000, tracy: 0 });
    expect(p.nick).toBe(0);
    expect(p.tracy).toBeCloseTo(57000, -1); // the whole household surplus: 5k + 60k − 8k
  });
});

describe("engine warnings and accrual guards", () => {
  it("names every short year, with amounts, in a single warning", () => {
    const s = defaultScenario();
    for (const id of ["nick", "tracy"] as const) {
      s.balances[id] = { ...s.balances[id], isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0 };
    }
    const w = simulate(s).warnings.filter((x) => x.includes("cash ran short"));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/ran short by £[\d,]+ in total: 20\d\d\/\d\d \(£[\d,]+ short from [A-Z][a-z]{2} 20\d\d\)/);
    expect(w[0]).toMatch(/and \d+ more year\(s\)/);
  });

  it("warns about a purchase dated outside the modelled period", () => {
    const s = defaultScenario();
    s.purchases = [{ id: "p1", label: "Boat", date: "2099-06-01", amount: 1000 }];
    expect(simulate(s).warnings).toContain(
      'Purchase "Boat" on 2099-06-01 falls outside the modelled period and is ignored.',
    );
  });

  it("never books interest on overdrawn cash as (negative) taxable savings income", () => {
    const s = defaultScenario();
    s.purchases = [{ id: "p1", label: "Too big", date: "2030-06-01", amount: 50_000_000 }];
    for (const y of simulate(s).years) {
      expect(y.tax.nick.savingsIncome).toBeGreaterThanOrEqual(0);
      expect(y.tax.tracy.savingsIncome).toBeGreaterThanOrEqual(0);
    }
  });

  it("accrues GIA dividends as yield / 12 a month (a yield, not a compound rate)", () => {
    const s = defaultScenario();
    s.rates.investmentGrowth = 0; // hold the GIA flat after the April Bed & ISA
    s.rates.giaDividendYield = 0.12;
    const gia = s.balances.nick.gia;
    const afterIsaFill = gia - Math.min(20000, gia);
    expect(simulate(s).years[0].tax.nick.dividends).toBeCloseTo(afterIsaFill * 0.12, 1);
  });
});

describe("buffer and ladder sizing", () => {
  const s = defaultScenario();
  const income = resolveIncome(s);
  const next = income.startYear + 1;
  const flat = (_year: number) => 80_000;

  it("sizes the buffer on the need net of State Pension, with fractional years", () => {
    expect(bufferTarget(flat, { ...s.strategy, bufferYears: 3 }, next)).toBeCloseTo(240_000, 6);
    expect(bufferTarget(flat, { ...s.strategy, bufferYears: 2.5 }, next)).toBeCloseTo(200_000, 6);
    expect(bufferTarget((y) => (y >= next + 1 ? 30_000 : 80_000), { ...s.strategy, bufferYears: 3 }, next)).toBeCloseTo(
      140_000,
      6,
    );
  });

  const ladder = (
    gilts: { maturityYear: number; nominal: number }[],
    cash: number,
    strategy = s.strategy,
    need: (year: number) => number = flat,
  ) => {
    const state = initState(s);
    state.gilts = gilts.map((g, i) => ({ id: `t${i}`, holder: "nick", name: "x", couponRate: 0, cost: g.nominal, purchaseYear: next - 1, ...g }));
    state.balances.nick.savings = cash / 2;
    state.balances.tracy.savings = cash / 2;
    const out = planGiltPurchases(state, need, s.rates, strategy, next);
    const byYear: Record<number, number> = {};
    for (const p of out) byYear[p.maturityYear] = (byYear[p.maturityYear] ?? 0) + p.nominal;
    return byYear;
  };

  it("buys each later window year's shortfall, nearest first, keeping next year's need as cash", () => {
    // Window next..next+2: next is cash (80k kept); next+1 and next+2 each need 80k of gilts.
    expect(ladder([], 80_000 + 200_000)).toEqual({ [next + 1]: 80_000, [next + 2]: 80_000 });
    expect(ladder([], 80_000 + 100_000)).toEqual({ [next + 1]: 80_000, [next + 2]: 20_000 });
  });

  it("repairs a small rung instead of repeating it, and counts gilts maturing next year as cash", () => {
    const held = [
      { maturityYear: next, nominal: 30_000 }, // pays part of next year: only 50k of cash kept
      { maturityYear: next + 1, nominal: 75_000 },
      { maturityYear: next + 2, nominal: 10_000 },
    ];
    expect(ladder(held, 50_000 + 100_000)).toEqual({ [next + 1]: 5_000, [next + 2]: 70_000 });
  });

  it("never buys beyond the buffer window or the ladder length, and sizes a fractional last year", () => {
    expect(ladder([], 1_000_000, { ...s.strategy, bufferYears: 3, giltLadderYears: 1 })).toEqual({ [next + 1]: 80_000 });
    expect(ladder([], 1_000_000, { ...s.strategy, bufferYears: 2.5, giltLadderYears: 5 })).toEqual({
      [next + 1]: 80_000,
      [next + 2]: 40_000,
    });
  });

  it("follows the need net of State Pension", () => {
    const need = (y: number) => (y >= next + 1 ? 30_000 : 80_000);
    expect(ladder([], 1_000_000, s.strategy, need)).toEqual({ [next + 1]: 30_000, [next + 2]: 30_000 });
  });
});
