import { describe, expect, it } from "vitest";
import type { ExpenseData } from "../model/expenseTypes";
import { defaultExpenseData } from "../model/expenseTypes";
import { migrateExpenseData } from "../model/migrate";
import {
  expenseDataToRows,
  rowsToExpenseData,
  type ExpenseRows,
} from "../../server/expenseMapping";

/** Expense data with every optional field exercised in both states:
 *  day set/null, currentBalance set/null, templateId set/null, paid 0/partial. */
function fullExpenseData(): ExpenseData {
  return {
    templates: {
      expenses: [
        { id: "t-council", name: "Council Tax", day: 1, amount: 307 },
        { id: "t-cleaner", name: "Cleaner", day: null, amount: 141 },
      ],
      income: [
        { id: "t-salary", name: "Raworths Salary", amount: 2879.24 },
        { id: "t-divs", name: "MCL Divs", amount: 8750 },
      ],
    },
    months: [
      {
        key: "2026-02",
        startBalance: 500,
        currentBalance: null,
        expenses: [
          { id: "m2-council", templateId: "t-council", name: "Council Tax", day: 1, amount: 0, paid: 0 },
        ],
        income: [{ id: "m2-salary", templateId: "t-salary", name: "Raworths Salary", amount: 2791.65 }],
      },
      {
        key: "2026-01",
        startBalance: 332.52,
        currentBalance: 714.41,
        expenses: [
          { id: "m1-council", templateId: "t-council", name: "Council Tax", day: 1, amount: 291, paid: 291 },
          { id: "m1-valet", templateId: null, name: "Car Valet", day: 5, amount: 60, paid: 30 },
          { id: "m1-cleaner", templateId: "t-cleaner", name: "Cleaner", day: null, amount: 258, paid: 0 },
        ],
        income: [
          { id: "m1-salary", templateId: "t-salary", name: "Raworths Salary", amount: 2791.65 },
          { id: "m1-oneoff", templateId: null, name: "Tax refund", amount: 123.45 },
        ],
      },
    ],
  };
}

/** FLOAT columns can come back as strings depending on driver settings;
 *  the mapping must coerce them (mirrors simulateDbReadback for scenarios). */
function simulateDbReadback(rows: ExpenseRows): ExpenseRows {
  const s = (v: number | string | null) => (v == null ? null : (String(v) as unknown as number));
  return {
    templates: rows.templates.map((r) => ({ ...r, amount: s(r.amount)!, dayOfMonth: s(r.dayOfMonth) })),
    months: rows.months.map((r) => ({
      ...r,
      startBalance: s(r.startBalance)!,
      currentBalance: s(r.currentBalance),
    })),
    items: rows.items.map((r) => ({
      ...r,
      amount: s(r.amount)!,
      paid: s(r.paid),
      dayOfMonth: s(r.dayOfMonth),
    })),
  };
}

describe("expense SQL row mapping", () => {
  it("round-trips fully populated expense data (months sorted chronologically)", () => {
    const d = fullExpenseData();
    const back = rowsToExpenseData(simulateDbReadback(expenseDataToRows(d)));
    const expected = structuredClone(d);
    expected.months.sort((a, b) => a.key.localeCompare(b.key)); // stored keyed by month
    expect(back).toEqual(expected);
  });

  it("round-trips the default (fresh-install) data", () => {
    const d = defaultExpenseData();
    const back = rowsToExpenseData(simulateDbReadback(expenseDataToRows(d)));
    expect(back).toEqual(d);
  });

  it("covers every expense field (guards against silently dropping new ones)", () => {
    const d = fullExpenseData();
    const back = rowsToExpenseData(simulateDbReadback(expenseDataToRows(d)));
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(back)).toEqual(keys(d));
    expect(keys(back.templates)).toEqual(keys(d.templates));
    expect(keys(back.templates.expenses[0])).toEqual(keys(d.templates.expenses[0]));
    expect(keys(back.templates.income[0])).toEqual(keys(d.templates.income[0]));
    const backJan = back.months.find((m) => m.key === "2026-01")!;
    const jan = d.months.find((m) => m.key === "2026-01")!;
    expect(keys(backJan)).toEqual(keys(jan));
    expect(keys(backJan.expenses[0])).toEqual(keys(jan.expenses[0]));
    expect(keys(backJan.income[0])).toEqual(keys(jan.income[0]));
  });

  it("preserves item order and float precision", () => {
    const d = fullExpenseData();
    const back = rowsToExpenseData(simulateDbReadback(expenseDataToRows(d)));
    const jan = back.months.find((m) => m.key === "2026-01")!;
    expect(jan.expenses.map((e) => e.id)).toEqual(["m1-council", "m1-valet", "m1-cleaner"]);
    expect(jan.startBalance).toBe(332.52);
    expect(jan.expenses[1].paid).toBe(30);
    expect(jan.income[1].amount).toBe(123.45);
  });
});

describe("expense data migration", () => {
  it("backfills structures missing from older saves", () => {
    const sparse = {
      templates: { expenses: undefined, income: undefined },
      months: [{ key: "2026-01", startBalance: 0 }],
    } as unknown as ExpenseData;
    const d = migrateExpenseData(sparse);
    expect(d.templates.expenses).toEqual([]);
    expect(d.templates.income).toEqual([]);
    expect(d.months[0].expenses).toEqual([]);
    expect(d.months[0].income).toEqual([]);
    expect(d.months[0].currentBalance).toBeNull();
  });
});
