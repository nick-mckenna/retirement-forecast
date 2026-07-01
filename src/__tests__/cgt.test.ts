import { describe, expect, it } from "vitest";
import { computeCGT } from "../tax/cgt";
import { projectTaxParams } from "../tax/taxParams";

const p = projectTaxParams(2028, 0.03); // CGT allowance 3,000; rates 18%/24%

describe("capital gains tax", () => {
  it("applies the annual exempt amount", () => {
    const { tax } = computeCGT(2500, 0, p);
    expect(tax).toBe(0);
  });

  it("taxes gains above the allowance at the higher rate when no basic band remains", () => {
    // gain 10,000 - 3,000 = 7,000 @ 24% = 1,680
    const { tax } = computeCGT(10000, 0, p);
    expect(tax).toBeCloseTo(1680, 2);
  });

  it("uses the lower rate for gains within the remaining basic band", () => {
    // gain 5,000 - 3,000 = 2,000, all within basic band -> 18% = 360
    const { tax } = computeCGT(5000, 10000, p);
    expect(tax).toBeCloseTo(360, 2);
  });
});
