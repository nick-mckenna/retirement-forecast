import { describe, expect, it } from "vitest";
import { personYearTax } from "../tax/personTax";
import { DEFAULT_TAX_POLICY, resolveTaxParams } from "../tax/taxParams";

// 2025/26 England & Wales figures (PA 12,570; basic band 37,700; CGT exempt 3,000 at 18%/24%).
// Hand-computed, synthetic amounts.
const p = resolveTaxParams([], 2025, DEFAULT_TAX_POLICY, 0);

describe("personYearTax — CGT uses the basic band the income left (after the PA)", () => {
  it("splits gains across the remaining basic band and the higher rate", () => {
    // Taxable income 40,000 − 12,570 = 27,430 → basic band left 37,700 − 27,430 = 10,270.
    // Taxable gain 20,000 − 3,000 = 17,000: 10,270 at 18% + 6,730 at 24% = 1,848.60 + 1,615.20.
    const t = personYearTax({ nonSavings: 40000, savings: 0, dividends: 0, gain: 20000 }, p);
    expect(t.taxableTotal).toBe(27430);
    expect(t.cgt).toBeCloseTo(3463.8, 2);
    expect(t.incomeTax).toBeCloseTo(27430 * 0.2, 2);
    expect(t.total).toBeCloseTo(3463.8 + 5486, 2);
  });

  it("taxes gains entirely at the higher rate once income fills the basic band", () => {
    const t = personYearTax({ nonSavings: 60000, savings: 0, dividends: 0, gain: 10000 }, p);
    expect(t.cgt).toBeCloseTo(7000 * 0.24, 2);
  });

  it("gives gains the whole basic band when there is no income", () => {
    const t = personYearTax({ nonSavings: 0, savings: 0, dividends: 0, gain: 20000 }, p);
    expect(t.cgt).toBeCloseTo(17000 * 0.18, 2);
    expect(t.incomeTax).toBe(0);
  });

  it("counts savings income towards the band before gains", () => {
    // Taxable 17,430 (non-savings) + 10,000 (savings) = 27,430 → 10,270 band left; gain 7,000 all at 18%.
    const t = personYearTax({ nonSavings: 30000, savings: 10000, dividends: 0, gain: 10000 }, p);
    expect(t.taxableTotal).toBe(27430);
    expect(t.cgt).toBeCloseTo(7000 * 0.18, 2);
  });

  it("handles the personal-allowance taper: no basic band left for gains", () => {
    // 110,000 income → PA 12,570 − 5,000 = 7,570 → taxable 102,430 (> basic band).
    // Income tax 37,700 × 20% + 64,730 × 40% = 7,540 + 25,892; gain 5,000 → 2,000 × 24%.
    const t = personYearTax({ nonSavings: 110000, savings: 0, dividends: 0, gain: 5000 }, p);
    expect(t.taxableTotal).toBe(102430);
    expect(t.incomeTax).toBeCloseTo(33432, 2);
    expect(t.cgt).toBeCloseTo(480, 2);
  });
});
