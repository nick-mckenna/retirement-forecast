import { describe, expect, it } from "vitest";
import { annualToMonthly } from "../model/rates";

describe("annualToMonthly", () => {
  it("matches the spreadsheet's Interest Rates monthly conversions", () => {
    // Sheet: S&S 7% -> 0.005654, Savings 3.5% -> 0.002871, Inflation 3% -> 0.002466
    expect(annualToMonthly(0.07)).toBeCloseTo(0.005654, 6);
    expect(annualToMonthly(0.035)).toBeCloseTo(0.002871, 6);
    expect(annualToMonthly(0.03)).toBeCloseTo(0.002466, 6);
  });

  it("compounds back to the annual rate over 12 months", () => {
    const m = annualToMonthly(0.07);
    expect(Math.pow(1 + m, 12) - 1).toBeCloseTo(0.07, 10);
  });
});
