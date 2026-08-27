import { describe, expect, it } from "vitest";
import type { TaxPolicy } from "../model/types";
import {
  BASE_TAX_PARAMS,
  DEFAULT_TAX_POLICY,
  projectTaxParams,
  resolveTaxParams,
} from "../tax/taxParams";

/** The nine cash allowances that uprating (when enabled) applies to. */
const CASH_FIELDS = [
  "personalAllowance",
  "basicRateBand",
  "higherRateBand",
  "psaBasic",
  "psaHigher",
  "savingsStartingRateBand",
  "dividendAllowance",
  "cgtAnnualExempt",
  "isaAllowance",
] as const;

describe("projectTaxParams", () => {
  it("holds every allowance flat under the default policy (0% uprating)", () => {
    expect(DEFAULT_TAX_POLICY).toEqual({ freezeUntilYear: 2031, uprating: 0 });
    const first = projectTaxParams(2028, DEFAULT_TAX_POLICY);
    for (const year of [2031, 2032, 2045, 2060]) {
      const p = projectTaxParams(year, DEFAULT_TAX_POLICY);
      expect({ ...p, year: 2028 }).toEqual(first);
    }
    // Spot-check the headline figures stay at the 2025/26 baseline.
    const late = projectTaxParams(2060, DEFAULT_TAX_POLICY);
    expect(late.personalAllowance).toBe(12570);
    expect(late.basicRateBand).toBe(37700);
    expect(late.cgtAnnualExempt).toBe(3000);
    expect(late.isaAllowance).toBe(20000);
  });

  it("keeps the freeze year itself at the baseline when uprating is on", () => {
    const policy: TaxPolicy = { freezeUntilYear: 2031, uprating: 0.02 };
    expect(projectTaxParams(2031, policy)).toEqual({ year: 2031, ...BASE_TAX_PARAMS });
    expect(projectTaxParams(2020, policy).personalAllowance).toBe(12570);
  });

  it("uprates every cash allowance after the freeze year, compounded and rounded", () => {
    const policy: TaxPolicy = { freezeUntilYear: 2031, uprating: 0.02 };
    const p = projectTaxParams(2033, policy);
    const factor = 1.02 ** 2;
    for (const f of CASH_FIELDS) {
      expect(p[f]).toBe(Math.round(BASE_TAX_PARAMS[f] * factor));
    }
    expect(p.personalAllowance).toBe(13078); // 12570 * 1.0404 = 13077.8
  });

  it("never uprates the tax rates or the PA taper threshold", () => {
    const p = projectTaxParams(2050, { freezeUntilYear: 2031, uprating: 0.05 });
    expect(p.basicRate).toBe(0.2);
    expect(p.higherRate).toBe(0.4);
    expect(p.additionalRate).toBe(0.45);
    expect(p.cgtBasicRate).toBe(0.18);
    expect(p.cgtHigherRate).toBe(0.24);
    expect(p.paTaperThreshold).toBe(100000);
  });

  it("moves the flat period when the freeze year moves", () => {
    const policy: TaxPolicy = { freezeUntilYear: 2040, uprating: 0.03 };
    expect(projectTaxParams(2040, policy).isaAllowance).toBe(20000);
    expect(projectTaxParams(2041, policy).isaAllowance).toBe(20600);
  });
});

describe("resolveTaxParams", () => {
  it("prefers a user-edited row over the projection", () => {
    const edited = { ...projectTaxParams(2035, DEFAULT_TAX_POLICY), personalAllowance: 20000 };
    expect(resolveTaxParams([edited], 2035, DEFAULT_TAX_POLICY).personalAllowance).toBe(20000);
    expect(resolveTaxParams([edited], 2036, DEFAULT_TAX_POLICY).personalAllowance).toBe(12570);
  });
});
