import { describe, expect, it } from "vitest";
import type { Scenario } from "../model/types";
import { defaultScenario, SCHEMA_VERSION } from "../model/defaults";
import { migrateScenario } from "../model/migrate";
import { DEFAULT_TAX_POLICY, projectTaxParams } from "../tax/taxParams";
import { rowsToScenario, scenarioToRows, type ScenarioRows } from "../../server/mapping";

/** A scenario with every optional/collection field populated. */
function fullScenario(): Scenario {
  const s = defaultScenario();
  s.id = "sc-full";
  s.name = "Fully populated";
  s.linkPreRetirement = true;
  s.income.mode = "swr";
  s.strategy.taxMode = "lifetime";
  s.strategy.lifetimeFillFraction = 0.65;
  s.married = true;
  s.rates.statePensionGrowth = 0.03;
  s.people.nick.statePensionAge = 66.5; // a fractional override; tracy stays statutory (null)
  s.people.tracy.lumpSumAllowanceUsed = 40_000;
  s.taxPolicy = { freezeUntilYear: 2035, indexation: "custom", uprating: 0.02 }; // non-default, so the columns are exercised
  s.taxParams = [
    { year: 2029, personalAllowance: 14000, savingsBasicRate: 0.22 }, // sparse: only the edited fields
    projectTaxParams(2028, s.taxPolicy, s.rates.inflation), // every field set
  ];
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
    expect(keys(back.taxPolicy)).toEqual(keys(s.taxPolicy));
    expect(keys(back.people.nick)).toEqual(keys(s.people.nick));
    expect(keys(back.balances.nick)).toEqual(keys(s.balances.nick));
    for (let i = 0; i < s.taxParams.length; i++) {
      const y = s.taxParams[i].year;
      expect(keys(back.taxParams.find((t) => t.year === y)!)).toEqual(keys(s.taxParams[i]));
    }
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
    expect(back.taxPolicy).toEqual({ freezeUntilYear: 2035, indexation: "custom", uprating: 0.02 });
  });

  it("round-trips the pre-retirement link flag (BIT column forms)", () => {
    const s = fullScenario();
    const rows = scenarioToRows(s, 0);
    expect(rowsToScenario({ ...rows, scenario: { ...rows.scenario, linkPreRetirement: 1 } }).linkPreRetirement).toBe(true);
    expect(rowsToScenario({ ...rows, scenario: { ...rows.scenario, linkPreRetirement: false } }).linkPreRetirement).toBe(false);
  });
});

describe("scenario migration", () => {
  it("backfills linkPreRetirement on pre-link saves", () => {
    const old = defaultScenario() as Partial<Scenario>;
    delete old.linkPreRetirement;
    expect(migrateScenario(old as Scenario).linkPreRetirement).toBe(false);
  });

  it("backfills taxPolicy on saves made before thresholds were frozen by default", () => {
    const old = defaultScenario() as Partial<Scenario>;
    delete old.taxPolicy;
    delete old.schemaVersion;
    expect(migrateScenario(old as Scenario).taxPolicy).toEqual(DEFAULT_TAX_POLICY);
  });
});

describe("scenario migration v1 → v2 (threshold policy, sparse tax edits)", () => {
  /** A v1 save: {freezeUntilYear, uprating} policy and whole stored tax rows. */
  function v1(policy: { freezeUntilYear: number; uprating: number }, rows: object[]): Scenario {
    const s = defaultScenario() as unknown as Record<string, unknown>;
    delete s.schemaVersion;
    s.taxPolicy = policy;
    s.taxParams = rows;
    return s as unknown as Scenario;
  }
  /** A whole v1 row as the v1 editor stored it: the v1 projection (flat at 0%) plus edits. */
  const v1Row = (year: number, edits: object = {}) => ({
    year,
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    higherRateBand: 87440,
    basicRate: 0.2,
    higherRate: 0.4,
    additionalRate: 0.45,
    psaBasic: 1000,
    psaHigher: 500,
    savingsStartingRateBand: 5000,
    dividendAllowance: 500,
    dividendBasicRate: 0.0875,
    dividendHigherRate: 0.3375,
    dividendAdditionalRate: 0.3935,
    cgtAnnualExempt: 3000,
    cgtBasicRate: 0.18,
    cgtHigherRate: 0.24,
    isaAllowance: 20000,
    ...edits,
  });

  it("turns the untouched v1 default {2031, 0%} into the statutory default", () => {
    const m = migrateScenario(v1({ freezeUntilYear: 2031, uprating: 0 }, []));
    expect(m.taxPolicy).toEqual(DEFAULT_TAX_POLICY);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("keeps any other v1 policy as a custom uprating", () => {
    const m = migrateScenario(v1({ freezeUntilYear: 2035, uprating: 0.02 }, []));
    expect(m.taxPolicy).toEqual({ freezeUntilYear: 2035, indexation: "custom", uprating: 0.02 });
  });

  it("keeps only the genuinely edited fields of each stored row, dropping untouched rows", () => {
    const m = migrateScenario(
      v1({ freezeUntilYear: 2031, uprating: 0 }, [v1Row(2030, { personalAllowance: 15000 }), v1Row(2031)]),
    );
    expect(m.taxParams).toEqual([{ year: 2030, personalAllowance: 15000 }]);
  });

  it("compares stored rows with v1's own uprated projection", () => {
    // What the v1 editor stored for 2033 under a 2% uprating from 2031 (factor 1.02² = 1.0404,
    // rounded), with one genuine edit: the ISA allowance.
    const row = v1Row(2033, {
      personalAllowance: 13078,
      basicRateBand: 39223,
      higherRateBand: 90973,
      psaBasic: 1040,
      psaHigher: 520,
      savingsStartingRateBand: 5202,
      dividendAllowance: 520,
      cgtAnnualExempt: 3121,
      isaAllowance: 30000,
    });
    const m = migrateScenario(v1({ freezeUntilYear: 2031, uprating: 0.02 }, [row]));
    expect(m.taxParams).toEqual([{ year: 2033, isaAllowance: 30000 }]);
  });

  it("leaves a v2 scenario's policy and edits alone", () => {
    const s = defaultScenario();
    s.taxPolicy = { freezeUntilYear: 2033, indexation: "custom", uprating: 0.01 };
    s.taxParams = [{ year: 2040, isaAllowance: 25000 }];
    const m = migrateScenario(s);
    expect(m.taxPolicy).toEqual(s.taxPolicy);
    expect(m.taxParams).toEqual(s.taxParams);
  });
});
