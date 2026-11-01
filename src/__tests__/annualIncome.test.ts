import { describe, expect, it } from "vitest";
import { emptyPersonColumns, INCOME_ROW_LABELS, INCOME_SOURCES, incomeByTaxYear } from "../engine/ledger";
import type { LedgerRow, RowType } from "../engine/ledger";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { statePensionForYear } from "../tax/statePension";

// Synthetic figures only — the point is the tax-year bucketing, not the amounts.
function row(type: RowType, dateIso: string, nickIncome: number, tracyIncome: number, label?: string): LedgerRow {
  return {
    type,
    label: label ?? (type === "BALANCE" ? "Year End" : "Income"),
    dateIso,
    nick: { ...emptyPersonColumns(), income: nickIncome },
    tracy: { ...emptyPersonColumns(), income: tracyIncome },
    savingsAndGilts: 0,
    netWorth: 0,
  };
}

/** bySource for rows that are all drawdown ("Income" rows). */
const drawn = (nick: number, tracy: number) => ({
  nick: { drawdown: nick, statePension: 0, finalIncome: 0 },
  tracy: { drawdown: tracy, statePension: 0, finalIncome: 0 },
});

describe("incomeByTaxYear", () => {
  it("totals each person's Income column per tax year, split on 6 April", () => {
    const rows = [
      row("TRANSACTION", "2030-04-06", 1000, 500), // first day of 2030/31
      row("TRANSACTION", "2031-04-05", 200, 300), // last day of 2030/31
      row("TRANSACTION", "2031-04-06", 50, 70), // first day of 2031/32
    ];
    expect(incomeByTaxYear(rows, [2030, 2031])).toEqual([
      { taxYearStart: 2030, nick: 1200, tracy: 800, total: 2000, bySource: drawn(1200, 800) },
      { taxYearStart: 2031, nick: 50, tracy: 70, total: 120, bySource: drawn(50, 70) },
    ]);
  });

  it("ignores BALANCE rows and rows outside the requested years", () => {
    const rows = [
      row("BALANCE", "2030-05-01", 9999, 9999),
      row("TRANSACTION", "2029-12-01", 4000, 4000), // 2029/30 — not requested
      row("TRANSACTION", "2030-05-01", 10, 20),
    ];
    expect(incomeByTaxYear(rows, [2030])).toEqual([
      { taxYearStart: 2030, nick: 10, tracy: 20, total: 30, bySource: drawn(10, 20) },
    ]);
  });

  it("returns a zero entry for a requested year with no income", () => {
    expect(incomeByTaxYear([], [2030])).toEqual([
      { taxYearStart: 2030, nick: 0, tracy: 0, total: 0, bySource: drawn(0, 0) },
    ]);
  });

  it("splits income by the row it came from", () => {
    const rows = [
      row("TRANSACTION", "2030-05-01", 1000, 1000, INCOME_ROW_LABELS.drawdown),
      row("TRANSACTION", "2030-05-01", 300, 0, INCOME_ROW_LABELS.statePension),
      row("TRANSACTION", "2030-06-30", 5000, 4000, INCOME_ROW_LABELS.finalIncome),
    ];
    const [y] = incomeByTaxYear(rows, [2030]);
    expect(y.bySource.nick).toEqual({ drawdown: 1000, statePension: 300, finalIncome: 5000 });
    expect(y.bySource.tracy).toEqual({ drawdown: 1000, statePension: 0, finalIncome: 4000 });
    expect(y.nick).toBe(6300);
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
      expect(income[0].bySource[id].drawdown).toBeCloseTo(y0.incomeTarget / 2, 2);
      expect(income[0].bySource[id].statePension).toBeCloseTo(statePension, 2);
      expect(income[0].bySource[id].finalIncome).toBeCloseTo(scenario.finalIncome.perPerson[id].net, 2);
    }
  });

  it("has no income outside the three sources: the parts add up to each person, every year", () => {
    for (const y of income) {
      for (const id of ["nick", "tracy"] as const) {
        const parts = INCOME_SOURCES.reduce((sum, src) => sum + y.bySource[id][src], 0);
        expect(parts).toBeCloseTo(y[id], 6);
      }
    }
    const other = result.rows.filter(
      (r) => r.type === "TRANSACTION" && !Object.values(INCOME_ROW_LABELS).includes(r.label as never),
    );
    expect(other.every((r) => r.nick.income === 0 && r.tracy.income === 0)).toBe(true);
  });
});
