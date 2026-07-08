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
 *  day set/null, currentBalance set/null, templateId set/null, paid 0/partial,
 *  accountId set/null (both on templates and on month lines). */
function fullExpenseData(): ExpenseData {
  return {
    templates: {
      expenses: [
        { id: "t-council", name: "Council Tax", day: 1, amount: 200, accountId: null },
        { id: "t-cleaner", name: "Cleaner", day: null, amount: 100, accountId: null },
        { id: "t-invest", name: "Savings / Investments", day: 30, amount: 2000, accountId: "nick-isa" },
      ],
      income: [
        { id: "t-salary", name: "Salary Nick", amount: 2500, accountId: null },
        { id: "t-divs", name: "Dividends", amount: 750, accountId: null },
        { id: "t-frompb", name: "From Premium Bonds", amount: 0, accountId: "tracy-premium-bonds" },
      ],
    },
    months: [
      {
        key: "2026-02",
        startBalance: 500,
        currentBalance: null,
        expenses: [
          { id: "m2-council", templateId: "t-council", name: "Council Tax", day: 1, amount: 0, paid: 0, accountId: null },
        ],
        income: [
          { id: "m2-salary", templateId: "t-salary", name: "Salary Nick", amount: 2450.75, accountId: null },
        ],
      },
      {
        key: "2026-01",
        startBalance: 321.09,
        currentBalance: 654.32,
        expenses: [
          { id: "m1-council", templateId: "t-council", name: "Council Tax", day: 1, amount: 210, paid: 210, accountId: null },
          { id: "m1-valet", templateId: null, name: "Car Valet", day: 5, amount: 60, paid: 30, accountId: null },
          { id: "m1-cleaner", templateId: "t-cleaner", name: "Cleaner", day: null, amount: 120, paid: 0, accountId: null },
          { id: "m1-invest", templateId: "t-invest", name: "Savings / Investments", day: 30, amount: 2000, paid: 2000, accountId: "nick-isa" },
        ],
        income: [
          { id: "m1-salary", templateId: "t-salary", name: "Salary Nick", amount: 2450.75, accountId: null },
          { id: "m1-oneoff", templateId: null, name: "Tax refund", amount: 123.45, accountId: null },
          { id: "m1-frompb", templateId: "t-frompb", name: "From Premium Bonds", amount: 1500, accountId: "tracy-premium-bonds" },
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
    expect(jan.expenses.map((e) => e.id)).toEqual(["m1-council", "m1-valet", "m1-cleaner", "m1-invest"]);
    expect(jan.startBalance).toBe(321.09);
    expect(jan.expenses[1].paid).toBe(30);
    expect(jan.income[1].amount).toBe(123.45);
  });

  it("preserves account tags on templates and month lines", () => {
    const d = fullExpenseData();
    const back = rowsToExpenseData(simulateDbReadback(expenseDataToRows(d)));
    expect(back.templates.expenses.find((e) => e.id === "t-invest")!.accountId).toBe("nick-isa");
    expect(back.templates.income.find((i) => i.id === "t-frompb")!.accountId).toBe("tracy-premium-bonds");
    const jan = back.months.find((m) => m.key === "2026-01")!;
    expect(jan.expenses.find((e) => e.id === "m1-invest")!.accountId).toBe("nick-isa");
    expect(jan.income.find((i) => i.id === "m1-frompb")!.accountId).toBe("tracy-premium-bonds");
    expect(jan.expenses.find((e) => e.id === "m1-council")!.accountId).toBeNull();
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

  it("backfills accountId on pre-tagging saves", () => {
    const old = {
      templates: {
        expenses: [{ id: "t1", name: "Council Tax", day: 1, amount: 200 }],
        income: [{ id: "t2", name: "Salary", amount: 1000 }],
      },
      months: [
        {
          key: "2026-01",
          startBalance: 0,
          currentBalance: null,
          expenses: [{ id: "e1", templateId: "t1", name: "Council Tax", day: 1, amount: 200, paid: 0 }],
          income: [{ id: "i1", templateId: "t2", name: "Salary", amount: 1000 }],
        },
      ],
    } as unknown as ExpenseData;
    const d = migrateExpenseData(old);
    expect(d.templates.expenses[0].accountId).toBeNull();
    expect(d.templates.income[0].accountId).toBeNull();
    expect(d.months[0].expenses[0].accountId).toBeNull();
    expect(d.months[0].income[0].accountId).toBeNull();
  });
});
