import { describe, expect, it } from "vitest";
import { emptyPersonColumns, incomeByTaxYear } from "../engine/ledger";
import type { LedgerRow, RowType } from "../engine/ledger";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { statePensionForYear } from "../tax/statePension";

// Synthetic figures only — the point is the tax-year bucketing, not the amounts.
function row(type: RowType, dateIso: string, nickIncome: number, tracyIncome: number): LedgerRow {
  return {
    type,
    label: type === "BALANCE" ? "Year End" : "Income",
    dateIso,
    nick: { ...emptyPersonColumns(), income: nickIncome },
    tracy: { ...emptyPersonColumns(), income: tracyIncome },
    savingsAndGilts: 0,
    netWorth: 0,
  };
}

describe("incomeByTaxYear", () => {
  it("totals each person's Income column per tax year, split on 6 April", () => {
    const rows = [
      row("TRANSACTION", "2030-04-06", 1000, 500), // first day of 2030/31
      row("TRANSACTION", "2031-04-05", 200, 300), // last day of 2030/31
      row("TRANSACTION", "2031-04-06", 50, 70), // first day of 2031/32
    ];
    expect(incomeByTaxYear(rows, [2030, 2031])).toEqual([
      { taxYearStart: 2030, nick: 1200, tracy: 800, total: 2000 },
      { taxYearStart: 2031, nick: 50, tracy: 70, total: 120 },
    ]);
  });

  it("ignores BALANCE rows and rows outside the requested years", () => {
    const rows = [
      row("BALANCE", "2030-05-01", 9999, 9999),
      row("TRANSACTION", "2029-12-01", 4000, 4000), // 2029/30 — not requested
      row("TRANSACTION", "2030-05-01", 10, 20),
    ];
    expect(incomeByTaxYear(rows, [2030])).toEqual([{ taxYearStart: 2030, nick: 10, tracy: 20, total: 30 }]);
  });

  it("returns a zero entry for a requested year with no income", () => {
    expect(incomeByTaxYear([], [2030])).toEqual([{ taxYearStart: 2030, nick: 0, tracy: 0, total: 0 }]);
  });
});

describe("incomeByTaxYear on a full simulation", () => {
  const scenario = defaultScenario();
  const result = simulate(scenario);
  const income = incomeByTaxYear(
    result.rows,
    result.years.map((y) => y.taxYearStart),
  );

  it("accounts for every transaction's income across the modelled years", () => {
    const ledgerTotal = result.rows
      .filter((r) => r.type === "TRANSACTION")
      .reduce((sum, r) => sum + r.nick.income + r.tracy.income, 0);
    const chartTotal = income.reduce((sum, y) => sum + y.total, 0);
    expect(chartTotal).toBeCloseTo(ledgerTotal, 2);
  });

  it("first year = half the income target + State Pension + the one-off final income, per person", () => {
    const y0 = result.years[0];
    for (const id of ["nick", "tracy"] as const) {
      const statePension = statePensionForYear(
        scenario.people[id],
        y0.taxYearStart,
        scenario.income.startYear,
        scenario.rates.inflation,
      );
      const expected = y0.incomeTarget / 2 + statePension + scenario.finalIncome.perPerson[id].net;
      expect(income[0][id]).toBeCloseTo(expected, 2);
    }
  });
});
