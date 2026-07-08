import { describe, expect, it } from "vitest";
import type { Scenario } from "../model/types";
import { defaultScenario } from "../model/defaults";
import { projectTaxParams } from "../tax/taxParams";
import { rowsToScenario, scenarioToRows, type ScenarioRows } from "../../server/mapping";

/** A scenario with every optional/collection field populated. */
function fullScenario(): Scenario {
  const s = defaultScenario();
  s.id = "sc-full";
  s.name = "Fully populated";
  s.income.mode = "swr";
  s.strategy.taxMode = "lifetime";
  s.strategy.lifetimeFillFraction = 0.65;
  s.taxParams = [projectTaxParams(2029, 0.03), projectTaxParams(2028, 0.03)];
  s.overrides = [
    { key: "2030:refill:nick:pension", amount: 12345.67 },
    { key: "2031:refill:tracy:isa", amount: 999 },
  ];
  s.purchases = [
    { id: "p2", label: "Car", date: "2031-06-01", amount: 30000 },
    { id: "p1", label: "House deposit", date: "2029-09-15", amount: 150000 },
  ];
  return s;
}

/** What the driver hands back: DATE columns become JS Dates at UTC midnight. */
function simulateDbReadback(rows: ScenarioRows): ScenarioRows {
  const d = (v: Date | string) => new Date(`${v}T00:00:00.000Z`);
  return {
    ...rows,
    scenario: {
      ...rows.scenario,
      startDate: d(rows.scenario.startDate),
      finalIncomeDate: d(rows.scenario.finalIncomeDate),
    },
    people: rows.people.map((p) => ({ ...p, dob: d(p.dob) })),
    purchases: rows.purchases.map((p) => ({ ...p, purchaseDate: d(p.purchaseDate) })),
  };
}

describe("SQL row mapping", () => {
  it("round-trips a fully populated scenario", () => {
    const s = fullScenario();
    const back = rowsToScenario(simulateDbReadback(scenarioToRows(s, 3)));
    const expected = structuredClone(s);
    expected.taxParams.sort((a, b) => a.year - b.year); // stored keyed by year
    expect(back).toEqual(expected);
  });

  it("round-trips the default scenario (no optional fields)", () => {
    const s = defaultScenario();
    const back = rowsToScenario(simulateDbReadback(scenarioToRows(s, 0)));
    expect(back).toEqual(s);
    expect("lifetimeFillFraction" in back.strategy).toBe(false);
  });

  it("covers every Scenario field (guards against silently dropping new ones)", () => {
    const s = fullScenario();
    const back = rowsToScenario(simulateDbReadback(scenarioToRows(s, 0)));
    // JSON-level comparison catches keys that exist but were mapped to undefined.
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(back)).toEqual(keys(s));
    expect(keys(back.strategy)).toEqual(keys(s.strategy));
    expect(keys(back.income)).toEqual(keys(s.income));
    expect(keys(back.rates)).toEqual(keys(s.rates));
    expect(keys(back.people.nick)).toEqual(keys(s.people.nick));
    expect(keys(back.balances.nick)).toEqual(keys(s.balances.nick));
    expect(keys(back.taxParams[0])).toEqual(keys(s.taxParams[0]));
    expect(keys(back.purchases[0])).toEqual(keys(s.purchases[0]));
    expect(keys(back.overrides[0])).toEqual(keys(s.overrides[0]));
    expect(keys(back.finalIncome)).toEqual(keys(s.finalIncome));
  });

  it("preserves purchase list order and float precision", () => {
    const s = fullScenario();
    const back = rowsToScenario(simulateDbReadback(scenarioToRows(s, 0)));
    expect(back.purchases.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(back.overrides[0].amount).toBe(12345.67);
    expect(back.strategy.lifetimeFillFraction).toBe(0.65);
  });
});
