import { describe, expect, it } from "vitest";
import { annualToMonthly } from "../model/rates";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";

// The engine applies growth exactly like the original spreadsheet:
//   invested balance grows by the monthly S&S rate; savings by the monthly savings rate;
//   the monthly income draw of £3,333/person comes out of savings.
// Illustrative sample figures — the point is the monthly mechanics, not the numbers.
describe("golden: monthly growth/draw mechanics", () => {
  const mInv = annualToMonthly(0.07);
  const mSav = annualToMonthly(0.035);

  it("an ISA grows 200,000 -> 201,130.83 in one month", () => {
    const isaStart = 200000;
    const isaGrowth = isaStart * mInv;
    expect(isaGrowth).toBeCloseTo(1130.83, 1);
    expect(isaStart + isaGrowth).toBeCloseTo(201130.83, 1);
  });

  it("savings 120,000 -> 117,011.51 after growth and a £3,333 draw", () => {
    const savStart = 120000;
    const savGrowth = savStart * mSav;
    expect(savGrowth).toBeCloseTo(344.51, 1);
    expect(savStart + savGrowth - 3333).toBeCloseTo(117011.51, 1);
  });
});

describe("full simulation smoke test", () => {
  const result = simulate(defaultScenario());

  it("produces a ledger and one summary per modelled tax year", () => {
    expect(result.rows.length).toBeGreaterThan(100);
    expect(result.years.length).toBe(48);
    expect(result.years[0].taxYearStart).toBe(2028);
  });

  it("hits the £80,000 first-year income target", () => {
    expect(result.years[0].incomeTarget).toBeCloseTo(80000, 2);
  });

  it("fills the Nick/Tracy Tax columns (non-zero tax once drawing pension)", () => {
    const anyTax = result.years.some((y) => y.tax.nick.total + y.tax.tracy.total > 0);
    expect(anyTax).toBe(true);
  });

  it("keeps net worth positive through the early retirement years", () => {
    expect(result.years[5].netWorthEnd).toBeGreaterThan(0);
  });

  it("maintains a cash+gilts buffer in the early years", () => {
    expect(result.years[0].bufferEnd).toBeGreaterThan(0);
  });

  it("records gilt rungs with purchase and maturity dates", () => {
    expect(result.gilts.length).toBeGreaterThan(1);
    // The £15,000 T30 held at the start is captured as an initial rung.
    expect(result.gilts.some((g) => g.initial && g.nominal === 15000)).toBe(true);
    // The ladder buys new rungs with a later maturity than purchase date.
    const bought = result.gilts.filter((g) => !g.initial);
    expect(bought.length).toBeGreaterThan(0);
    expect(bought.every((g) => g.maturityDateIso > g.purchaseDateIso)).toBe(true);
  });
});
