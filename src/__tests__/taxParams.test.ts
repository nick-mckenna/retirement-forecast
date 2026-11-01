import { describe, expect, it } from "vitest";
import type { TaxPolicy } from "../model/types";
import {
  BASE_TAX_PARAMS,
  DEFAULT_TAX_POLICY,
  TAX_PARAM_FIELDS,
  baselineFor,
  projectTaxParams,
  resolveTaxParams,
} from "../tax/taxParams";

const STATUTORY: TaxPolicy = { ...DEFAULT_TAX_POLICY };

describe("baseline schedule", () => {
  it("defaults to a freeze to 2030/31 then statutory indexation", () => {
    expect(DEFAULT_TAX_POLICY).toEqual({ freezeUntilYear: 2030, indexation: "statutory", uprating: 0 });
  });

  it("starts from the 2025/26 figures", () => {
    expect(baselineFor(2025)).toEqual(BASE_TAX_PARAMS);
    expect(BASE_TAX_PARAMS.savingsBasicRate).toBe(0.2); // savings rates equal the main rates in 2025/26
  });

  it("raises dividend rates from 2026/27 and savings rates from 2027/28", () => {
    const y26 = baselineFor(2026);
    expect([y26.dividendBasicRate, y26.dividendHigherRate, y26.dividendAdditionalRate]).toEqual([
      0.1075, 0.3575, 0.3935,
    ]);
    expect(y26.savingsBasicRate).toBe(0.2);
    const y27 = baselineFor(2027);
    expect([y27.savingsBasicRate, y27.savingsHigherRate, y27.savingsAdditionalRate]).toEqual([0.24, 0.44, 0.49]);
    expect(y27.dividendBasicRate).toBe(0.1075); // earlier changes carry forward
    expect(baselineFor(2050)).toEqual(y27);
  });

  it("lists every parameter exactly once", () => {
    expect([...TAX_PARAM_FIELDS].sort()).toEqual(Object.keys(BASE_TAX_PARAMS).sort());
  });
});

describe("projectTaxParams — statutory indexation", () => {
  it("holds thresholds frozen through the freeze year, whatever inflation is", () => {
    const p = projectTaxParams(2030, STATUTORY, 0.03);
    expect(p.personalAllowance).toBe(12570);
    expect(p.basicRateBand).toBe(37700);
    expect(p.higherRateBand).toBe(87440);
  });

  it("indexes the personal allowance and basic band with inflation after it, keeping £125,140 fixed", () => {
    const p = projectTaxParams(2032, STATUTORY, 0.03); // two years after the freeze
    expect(p.personalAllowance).toBe(Math.round(12570 * 1.03 ** 2));
    expect(p.basicRateBand).toBe(Math.round(37700 * 1.03 ** 2));
    expect(p.basicRateBand + p.higherRateBand).toBe(125140);
    // Not indexed by statute: the taper threshold, rates and the other allowances.
    expect(p.paTaperThreshold).toBe(100000);
    expect(p.psaBasic).toBe(1000);
    expect(p.dividendAllowance).toBe(500);
    expect(p.cgtAnnualExempt).toBe(3000);
    expect(p.isaAllowance).toBe(20000);
    expect(p.basicRate).toBe(0.2);
  });

  it("stays flat with zero inflation", () => {
    const p = projectTaxParams(2060, STATUTORY, 0);
    expect(p.personalAllowance).toBe(12570);
    expect(p.basicRateBand).toBe(37700);
  });

  it("narrows the higher band to nothing once the basic band reaches £125,140", () => {
    const p = projectTaxParams(2090, STATUTORY, 0.03);
    expect(p.basicRateBand).toBeGreaterThan(125140);
    expect(p.higherRateBand).toBe(0);
  });
});

describe("projectTaxParams — custom uprating", () => {
  const custom: TaxPolicy = { freezeUntilYear: 2031, indexation: "custom", uprating: 0.02 };

  it("uprates the cash allowances, compounded and rounded, after the freeze year", () => {
    const p = projectTaxParams(2033, custom, 0.05); // inflation is ignored in custom mode
    const f = 1.02 ** 2;
    for (const k of [
      "personalAllowance",
      "basicRateBand",
      "psaBasic",
      "psaHigher",
      "savingsStartingRateBand",
      "dividendAllowance",
      "cgtAnnualExempt",
      "isaAllowance",
    ] as const) {
      expect(p[k]).toBe(Math.round(BASE_TAX_PARAMS[k] * f));
    }
    expect(p.personalAllowance).toBe(13078); // 12570 * 1.0404 = 13077.8
  });

  it("never moves the £125,140 additional-rate threshold, the taper threshold or any rate", () => {
    const p = projectTaxParams(2050, { ...custom, uprating: 0.05 }, 0);
    expect(p.basicRateBand + p.higherRateBand).toBe(125140);
    expect(p.paTaperThreshold).toBe(100000);
    expect(p.higherRate).toBe(0.4);
    expect(p.cgtHigherRate).toBe(0.24);
  });

  it("keeps the freeze year itself at the baseline", () => {
    expect(projectTaxParams(2031, custom, 0)).toEqual({ year: 2031, ...baselineFor(2031) });
  });

  it("moves the flat period when the freeze year moves", () => {
    const later: TaxPolicy = { freezeUntilYear: 2040, indexation: "custom", uprating: 0.03 };
    expect(projectTaxParams(2040, later, 0).isaAllowance).toBe(20000);
    expect(projectTaxParams(2041, later, 0).isaAllowance).toBe(20600);
  });
});

describe("resolveTaxParams — sparse edits", () => {
  it("lays only the edited fields over the projection", () => {
    const edits = [{ year: 2035, personalAllowance: 20000 }];
    const p = resolveTaxParams(edits, 2035, STATUTORY, 0.025);
    expect(p.personalAllowance).toBe(20000);
    expect(p.basicRateBand).toBe(projectTaxParams(2035, STATUTORY, 0.025).basicRateBand);
    expect(resolveTaxParams(edits, 2036, STATUTORY, 0.025).personalAllowance).toBe(
      projectTaxParams(2036, STATUTORY, 0.025).personalAllowance,
    );
  });

  it("keeps an edit while the un-edited fields follow a changed inflation assumption", () => {
    const edits = [{ year: 2035, isaAllowance: 25000 }];
    const low = resolveTaxParams(edits, 2035, STATUTORY, 0.01);
    const high = resolveTaxParams(edits, 2035, STATUTORY, 0.04);
    expect(low.isaAllowance).toBe(25000);
    expect(high.isaAllowance).toBe(25000);
    expect(high.personalAllowance).toBeGreaterThan(low.personalAllowance);
  });
});
