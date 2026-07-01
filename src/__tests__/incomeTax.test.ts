import { describe, expect, it } from "vitest";
import { computeIncomeTax } from "../tax/incomeTax";
import { projectTaxParams } from "../tax/taxParams";

const p = projectTaxParams(2028, 0.03); // frozen baseline: PA 12,570, basic band 37,700

describe("income tax", () => {
  it("basic-rate employment/pension income", () => {
    // £30,000 non-savings: taxable 17,430 @ 20% = 3,486
    const r = computeIncomeTax({ nonSavings: 30000, savings: 0, dividends: 0 }, p);
    expect(r.tax).toBeCloseTo(3486, 2);
  });

  it("higher-rate income spans two bands", () => {
    // £60,000: 37,700 @20 = 7,540 ; 9,730 @40 = 3,892 ; total 11,432
    const r = computeIncomeTax({ nonSavings: 60000, savings: 0, dividends: 0 }, p);
    expect(r.tax).toBeCloseTo(11432, 2);
  });

  it("income within the personal allowance is untaxed", () => {
    const r = computeIncomeTax({ nonSavings: 10000, savings: 0, dividends: 0 }, p);
    expect(r.tax).toBe(0);
  });

  it("savings interest uses the personal savings allowance", () => {
    // £20,000 non-savings (7,430 taxable basic) + £2,000 interest.
    // PSA basic £1,000 -> £1,000 of interest taxed @20% = £200. Plus 7,430@20 = 1,486.
    const r = computeIncomeTax({ nonSavings: 20000, savings: 2000, dividends: 0 }, p);
    expect(r.tax).toBeCloseTo(1686, 2);
  });

  it("dividends use the dividend allowance then dividend rates", () => {
    // £20,000 non-savings + £5,000 dividends: 7,430@20=1,486 ; dividends 500 free,
    // 4,500 @ 8.75% = 393.75 ; total 1,879.75
    const r = computeIncomeTax({ nonSavings: 20000, savings: 0, dividends: 5000 }, p);
    expect(r.tax).toBeCloseTo(1879.75, 2);
  });

  it("tapers the personal allowance above £100,000", () => {
    // £110,000 non-savings: PA tapered by (110,000-100,000)/2 = 5,000 -> PA 7,570.
    // taxable 102,430: 37,700@20=7,540 ; 64,730@40=25,892 ; total 33,432
    const r = computeIncomeTax({ nonSavings: 110000, savings: 0, dividends: 0 }, p);
    expect(r.tax).toBeCloseTo(33432, 2);
  });
});
