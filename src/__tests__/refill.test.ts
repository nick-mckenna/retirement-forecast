import { describe, expect, it } from "vitest";
import { simulate } from "../engine/simulate";
import { initState } from "../engine/state";
import { defaultScenario } from "../model/defaults";
import { resolveIncome, targetForYear } from "../model/incomeTargets";
import type { Scenario, StrategyConfig } from "../model/types";
import { planGiltPurchases } from "../strategy/giltLadder";

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

  it("keeps a full year of the next year's income as cash after tax (the ladder reserves it)", () => {
    for (let i = 0; i < result.years.length - 1; i++) {
      const cash = yearEnds[i].nick.savings + yearEnds[i].tracy.savings;
      expect(cash, `${result.years[i].taxYearStart}/${result.years[i].taxYearStart + 1}`).toBeGreaterThanOrEqual(
        result.years[i + 1].incomeTarget - 1,
      );
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
    const out = planGiltPurchases(state, income, s.rates, s.strategy, next, reserved);
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
