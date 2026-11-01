import { describe, expect, it } from "vitest";
import { initState } from "../engine/state";
import { makePlan, raiseCash, raiseCashMarginal } from "../strategy/drawdown";
import { DEFAULT_TAX_POLICY, projectTaxParams } from "../tax/taxParams";
import { defaultScenario } from "../model/defaults";
import { runForecast, totalTaxOf } from "../strategy/optimiser";

describe("marginal-cost optimiser (per-year)", () => {
  const scenario = defaultScenario();
  const p = projectTaxParams(2028, DEFAULT_TAX_POLICY, 0.025);

  it("raises approximately the requested amount", () => {
    const state = initState(scenario);
    const plans = {
      nick: makePlan("nick", true, 0, 0.3, p),
      tracy: makePlan("tracy", true, 0, 0.3, p),
    };
    const ws = raiseCashMarginal(state, 50000, { plans, config: scenario.strategy, year: 2028 });
    const raised = ws.reduce((s, w) => s + w.gross, 0);
    expect(raised).toBeCloseTo(50000, 0);
  });

  it("uses zero-tax sources first (drains ISA before taxing anything)", () => {
    const state = initState(scenario);
    const plans = {
      nick: makePlan("nick", true, 0, 0.3, p),
      tracy: makePlan("tracy", true, 0, 0.3, p),
    };
    // 20k is well within the available ISA balances, so nothing should be taxed.
    const ws = raiseCashMarginal(state, 20000, { plans, config: scenario.strategy, year: 2028 });
    const taxable = ws.reduce((s, w) => s + w.taxableNonSavings + w.realisedGain, 0);
    expect(taxable).toBe(0);
    expect(ws.every((w) => w.source === "isa")).toBe(true);
  });
});

describe("lifetime optimiser (whole-period)", () => {
  it("never does worse than its own no-crystallisation baseline", () => {
    const base = defaultScenario();

    const annual = runForecast({ ...base, strategy: { ...base.strategy, taxMode: "annual" } });
    const lifetime = runForecast({ ...base, strategy: { ...base.strategy, taxMode: "lifetime" } });

    // The lifetime search includes a "no top-up" candidate equal to annual mode, so the
    // chosen strategy's total tax can never exceed annual mode's.
    expect(lifetime.totalTax).toBeLessThanOrEqual(annual.totalTax + 1);
    expect(lifetime.search?.length).toBe(6);
  });

  it("heuristic and annual modes both produce a full forecast", () => {
    const base = defaultScenario();
    const heuristic = runForecast(base);
    const annual = runForecast({ ...base, strategy: { ...base.strategy, taxMode: "annual" } });
    expect(heuristic.result.years.length).toBe(48);
    expect(annual.result.years.length).toBe(48);
    expect(totalTaxOf(heuristic.result)).toBeGreaterThan(0);
  });
});

describe("heuristic band tops (taper- and savings-aware)", () => {
  // Once thresholds are indexed, PA + basic band can pass the fixed £100k taper threshold.
  const p = projectTaxParams(2060, DEFAULT_TAX_POLICY, 0.03);
  const scenario = defaultScenario();
  const pensionOnly = () => {
    const state = initState(scenario);
    for (const id of ["nick", "tracy"] as const) {
      state.balances[id] = { ...state.balances[id], isa: 0, gia: 0, pension: 2_000_000 };
    }
    return state;
  };

  it("stops 'within band' pension draws at the taper threshold", () => {
    expect(p.personalAllowance + p.basicRateBand).toBeGreaterThan(p.paTaperThreshold);
    const plans = {
      nick: makePlan("nick", true, 0, 0, p),
      tracy: makePlan("tracy", true, 0, 0, p),
    };
    const ws = raiseCash(pensionOnly(), 150_000, { plans, config: scenario.strategy, year: 2060 });
    for (const id of ["nick", "tracy"] as const) {
      const taxable = ws.filter((w) => w.person === id).reduce((s, w) => s + w.taxableNonSavings, 0);
      expect(taxable).toBeLessThanOrEqual(p.paTaperThreshold + 0.01);
    }
  });

  it("leaves band room for the year's savings income, shifting the draw to the spouse", () => {
    const p25 = projectTaxParams(2025, DEFAULT_TAX_POLICY, 0);
    const plans = {
      nick: makePlan("nick", true, 0, 0, p25, 10_000), // £10k of interest already this year
      tracy: makePlan("tracy", true, 0, 0, p25, 0),
    };
    const ws = raiseCash(pensionOnly(), 80_000, { plans, config: scenario.strategy, year: 2025 });
    const nickTaxable = ws
      .filter((w) => w.person === "nick" && w.source === "pension")
      .reduce((s, w) => s + w.taxableNonSavings, 0);
    // Nick's pension stops 10k short of the basic-rate top so his interest stays basic-rate.
    expect(nickTaxable).toBeCloseTo(p25.personalAllowance + p25.basicRateBand - 10_000, 0);
    expect(ws.some((w) => w.person === "tracy" && w.source === "pension")).toBe(true);
  });
});
