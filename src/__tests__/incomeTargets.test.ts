import { describe, expect, it } from "vitest";
import {
  buildIncomeTargets,
  investableAssets,
  resolveIncome,
  sumTargets,
  targetForYear,
} from "../model/incomeTargets";
import { defaultScenario } from "../model/defaults";
import { simulate } from "../engine/simulate";

const cfg = {
  mode: "fixed" as const,
  baseAnnual: 80000,
  swrRate: 0.035,
  startYear: 2028,
  years: 48,
  growth: 0.03,
};

describe("income targets", () => {
  it("reproduces the sheet: 80,000 inflating 3% per year", () => {
    const rows = buildIncomeTargets(cfg);
    expect(rows[0].annual).toBeCloseTo(80000, 2);
    expect(rows[1].annual).toBeCloseTo(82400, 2);
    expect(rows[2].annual).toBeCloseTo(84872, 2);
    expect(rows[0].monthly).toBeCloseTo(6666.67, 2);
  });

  it("targetForYear extrapolates with compound growth", () => {
    expect(targetForYear(cfg, 2028)).toBeCloseTo(80000, 2);
    expect(targetForYear(cfg, 2030)).toBeCloseTo(80000 * 1.03 ** 2, 2);
  });

  it("sumTargets adds consecutive years (3-year buffer)", () => {
    const three = 80000 + 82400 + 84872;
    expect(sumTargets(cfg, 2028, 3)).toBeCloseTo(three, 2);
  });
});

describe("safe withdrawal rate income mode", () => {
  it("derives year-1 income from a % of investable assets (ISA+Pension+GIA)", () => {
    const scenario = defaultScenario();
    scenario.income.mode = "swr";
    scenario.income.swrRate = 0.035;

    // ISA + Pension + GIA for both, excluding savings & gilts.
    const assets =
      200000 + 1000000 + 90000 + (180000 + 750000 + 90000);
    expect(investableAssets(scenario)).toBeCloseTo(assets, 2);
    expect(resolveIncome(scenario).baseAnnual).toBeCloseTo(0.035 * assets, 2);
  });

  it("feeds the simulation's year-1 income target", () => {
    const scenario = defaultScenario();
    scenario.income.mode = "swr";
    scenario.income.swrRate = 0.035;
    const result = simulate(scenario);
    expect(result.years[0].incomeTarget).toBeCloseTo(0.035 * investableAssets(scenario), 2);
  });
});
