import { describe, expect, it } from "vitest";
import { simulate, type YearSummary } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import type { Scenario } from "../model/types";

function totalSold(y: YearSummary): number {
  const s = y.disposals.sales;
  return s.nick.pension + s.nick.gia + s.nick.isa + s.tracy.pension + s.tracy.gia + s.tracy.isa;
}

describe("one-off purchases", () => {
  const base = defaultScenario();
  const withPurchase: Scenario = {
    ...base,
    purchases: [{ id: "p1", label: "House", date: "2035-06-15", amount: 300000 }],
  };
  const r0 = simulate(base);
  const r1 = simulate(withPurchase);

  it("inserts Fund and Purchase ledger rows on the purchase date", () => {
    const fund = r1.rows.find((row) => row.label === "Fund: House");
    const purchase = r1.rows.find((row) => row.label === "Purchase: House");
    expect(fund).toBeTruthy();
    expect(purchase).toBeTruthy();
    // Dated within the 2035/36 tax year.
    expect(purchase!.dateIso.startsWith("2035")).toBe(true);
  });

  it("funds the purchase by selling ~the purchase amount of investments that year", () => {
    const y0 = r0.years.find((y) => y.taxYearStart === 2035)!;
    const y1 = r1.years.find((y) => y.taxYearStart === 2035)!;
    expect(totalSold(y1) - totalSold(y0)).toBeGreaterThan(300000 * 0.8);
  });

  it("reduces end net worth (cash spent plus any tax on the sales)", () => {
    const nw0 = r0.years[r0.years.length - 1].netWorthEnd;
    const nw1 = r1.years[r1.years.length - 1].netWorthEnd;
    expect(nw1).toBeLessThan(nw0);
  });

  it("has no purchase rows when the list is empty", () => {
    expect(r0.rows.some((row) => row.label.startsWith("Purchase:"))).toBe(false);
  });
});
