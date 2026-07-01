import { describe, expect, it } from "vitest";
import { initState } from "../engine/state";
import { makePlan, raiseCashMarginal } from "../strategy/drawdown";
import { projectTaxParams } from "../tax/taxParams";
import { defaultScenario } from "../model/defaults";
import { runForecast, totalTaxOf } from "../strategy/optimiser";

describe("marginal-cost optimiser (per-year)", () => {
  const scenario = defaultScenario();
  const p = projectTaxParams(2028, 0.03);

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
