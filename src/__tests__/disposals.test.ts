import { describe, expect, it } from "vitest";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";

describe("per-year disposals are recorded", () => {
  const result = simulate(defaultScenario());

  it("records the annual Bed & ISA fill", () => {
    // £20k ISA allowance is filled from the GIA in the first year.
    expect(result.years[0].disposals.isaFill.nick).toBeGreaterThan(0);
    expect(result.years[0].disposals.isaFill.tracy).toBeGreaterThan(0);
  });

  it("records pension drawdown as a disposal once someone is drawing it", () => {
    const anyPensionSale = result.years.some(
      (y) => y.disposals.sales.nick.pension + y.disposals.sales.tracy.pension > 0,
    );
    expect(anyPensionSale).toBe(true);
  });

  it("realised gain in disposals matches the tax computation input", () => {
    for (const y of result.years) {
      expect(y.disposals.realisedGain.nick).toBeCloseTo(y.tax.nick.realisedGain, 2);
      expect(y.disposals.realisedGain.tracy).toBeCloseTo(y.tax.tracy.realisedGain, 2);
    }
  });

  it("records gilt redemptions at maturity", () => {
    const anyMaturity = result.years.some(
      (y) => y.disposals.giltMaturities.nick + y.disposals.giltMaturities.tracy > 0,
    );
    expect(anyMaturity).toBe(true);
  });
});
