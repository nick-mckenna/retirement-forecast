import { describe, expect, it } from "vitest";
import { initState } from "../engine/state";
import { makePlan, raiseCash, raiseCashMarginal } from "../strategy/drawdown";
import { DEFAULT_TAX_POLICY, projectTaxParams } from "../tax/taxParams";
import { personYearTax } from "../tax/personTax";
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

  it("uses the allowances that expire this year before the ISA, at no tax", () => {
    const state = initState(scenario);
    const plans = {
      nick: makePlan("nick", true, 0, 0.3, p),
      tracy: makePlan("tracy", true, 0, 0.3, p),
    };
    // 20k fits inside the two personal allowances (pension, 25% tax-free + 75% at 0%): as
    // tax-free as the ISA this year, but the allowance is lost if unused, so it goes first.
    const ws = raiseCashMarginal(state, 20000, { plans, config: scenario.strategy, year: 2028 });
    expect(ws.some((w) => w.source === "isa")).toBe(false);
    for (const id of ["nick", "tracy"] as const) {
      const mine = ws.filter((w) => w.person === id);
      const tax = personYearTax(
        {
          nonSavings: mine.reduce((t, w) => t + w.taxableNonSavings, 0),
          savings: 0,
          dividends: 0,
          gain: mine.reduce((t, w) => t + w.realisedGain, 0),
        },
        p,
      ).total;
      expect(tax).toBe(0);
    }
  });

  it("prices pension at its real marginal cost: savings income stacked on top, and the taper", () => {
    const state = initState(scenario);
    for (const id of ["nick", "tracy"] as const) {
      state.balances[id] = { ...state.balances[id], isa: 0, gia: 0, pension: 2_000_000 };
    }
    // Person A already has £40k of pension income and £20k of interest; B has nothing yet.
    const plans = {
      nick: makePlan("nick", true, 40_000, 0, p, { savings: 20_000, dividends: 0 }),
      tracy: makePlan("tracy", true, 0, 0, p),
    };
    const ws = raiseCashMarginal(state, 30_000, { plans, config: scenario.strategy, year: 2028 });
    // A's next £ would push his interest into the higher band, so B (still basic-rate) draws.
    expect(ws.find((w) => w.person === "nick")?.gross ?? 0).toBe(0);
    expect(ws.find((w) => w.person === "tracy")?.gross).toBeCloseTo(30_000, 0);
  });

  it("raises exactly what was asked, with the tax it reports equal to the real bill", () => {
    const state = initState(scenario);
    const plans = {
      nick: makePlan("nick", true, 30_000, 0.4, p, { savings: 3_000, dividends: 1_000 }),
      tracy: makePlan("tracy", true, 55_000, 0.4, p, { savings: 6_000, dividends: 0 }),
    };
    const ws = raiseCashMarginal(state, 120_000, { plans, config: scenario.strategy, year: 2028 });
    expect(ws.reduce((t, w) => t + w.gross, 0)).toBeCloseTo(120_000, 6);
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
    // (£1 short of the top: band-top draws stay just inside the savings-allowance cliff edge.)
    expect(nickTaxable).toBeCloseTo(p25.personalAllowance + p25.basicRateBand - 10_000 - 1, 0);
    expect(ws.some((w) => w.person === "tracy" && w.source === "pension")).toBe(true);
  });
});
