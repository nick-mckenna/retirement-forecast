import { describe, expect, it } from "vitest";
import type { ExpenseMonth } from "../model/expenseTypes";
import { defaultExpenseData } from "../model/expenseTypes";
import {
  addMonths,
  createMonthFromTemplates,
  defaultMonthKey,
  isMonthKey,
  monthKeysBetween,
  monthLabel,
  monthWarnings,
  nextMonthKey,
  summariseMonth,
} from "../expenses/calc";

/** A synthetic sample month exercising every summary field. The formulas
 *  mirror the original expenditure spreadsheet (Amount/Paid/To Pay totals,
 *  income-side total, "Balance To Reach 0", "Predicted"); the figures are
 *  illustrative — never real data. One line (Broadband, 40) is unpaid. */
function sampleMonth(): ExpenseMonth {
  const e = (name: string, day: number | null, amount: number, paid: number) => ({
    id: `2026-01:${name}`,
    templateId: null,
    name,
    day,
    amount,
    paid,
    accountId: null,
  });
  const inc = (name: string, amount: number) => ({
    id: `2026-01:${name}`,
    templateId: null,
    name,
    amount,
    accountId: null,
  });
  return {
    key: "2026-01",
    startBalance: 500,
    currentBalance: 900,
    expenses: [
      e("Savings / Investments", 30, 2000, 2000),
      e("Mortgage", 1, 1200, 1200),
      e("Credit Card", 13, 850.5, 850.5),
      e("Council Tax", 1, 150, 150),
      e("Energy", 12, 200, 200),
      e("Water", 1, 60, 60),
      e("Broadband", 31, 40, 0),
    ],
    income: [
      inc("Salary Nick", 2500),
      inc("Salary Tracy", 1600),
      inc("Dividends", 500),
    ],
  };
}

describe("month summary (spreadsheet formulas, synthetic figures)", () => {
  it("reproduces the sheet's totals for the sample month", () => {
    const s = summariseMonth(sampleMonth());
    expect(s.totalExpenses).toBeCloseTo(4500.5, 2); // Σ Amount
    expect(s.totalPaid).toBeCloseTo(4460.5, 2); // Σ Paid
    expect(s.totalToPay).toBeCloseTo(40, 2); // Σ(Amount − Paid)
    expect(s.totalAvailable).toBeCloseTo(5100, 2); // start balance + income
    expect(s.headroom).toBeCloseTo(599.5, 2); // "Balance To Reach 0"
    expect(s.predicted).toBeCloseTo(860, 2); // currentBalance − To Pay
  });

  it("flags a month whose expenses exceed the money coming in", () => {
    // Expenses total 5,200 vs start 750 + income 4,300 → 150 short.
    const m = sampleMonth();
    m.key = "2026-03";
    m.expenses = [
      { id: "x", templateId: null, name: "Everything", day: null, amount: 5200, paid: 1800, accountId: null },
    ];
    m.startBalance = 750;
    m.income = [{ id: "i", templateId: null, name: "All income", amount: 4300, accountId: null }];
    m.currentBalance = 3600;
    const s = summariseMonth(m);
    expect(s.headroom).toBeCloseTo(-150, 2); // negative ⇒ heading below zero
    expect(s.predicted).toBeCloseTo(200, 2); // fine because savings top it up
    const w = monthWarnings(m);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("below zero");
  });

  it("warns when remaining payments exceed the current balance", () => {
    const m = sampleMonth();
    m.currentBalance = 20; // 40 still to pay
    const w = monthWarnings(m);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("top the account up");
  });

  it("leaves predicted null until a current balance is entered", () => {
    const m = sampleMonth();
    m.currentBalance = null;
    expect(summariseMonth(m).predicted).toBeNull();
    expect(monthWarnings(m)).toHaveLength(0);
  });
});

describe("month creation from templates", () => {
  it("snapshots every standard item with paid = 0", () => {
    const { templates } = defaultExpenseData();
    const m = createMonthFromTemplates(templates, "2026-08", 500);
    expect(m.key).toBe("2026-08");
    expect(m.startBalance).toBe(500);
    expect(m.currentBalance).toBeNull();
    expect(m.expenses).toHaveLength(templates.expenses.length);
    expect(m.income).toHaveLength(templates.income.length);
    expect(m.expenses.every((e) => e.paid === 0)).toBe(true);
    // Snapshot copies the template values and remembers where each line came from.
    const energy = m.expenses.find((e) => e.name === "Energy")!;
    expect(energy.amount).toBe(200);
    expect(energy.day).toBe(12);
    expect(energy.templateId).toBe("exp-energy");
    // Editing the snapshot must not be able to touch the template (fresh objects).
    expect(m.expenses.some((e) => (e as unknown) === (templates.expenses[0] as unknown))).toBe(false);
  });
});

describe("month keys", () => {
  it("validates and formats keys", () => {
    expect(isMonthKey("2026-01")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-1")).toBe(false);
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
  });

  it("rolls over year boundaries", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-07", 6)).toBe("2027-01");
  });

  it("enumerates inclusive ranges across year boundaries", () => {
    expect(monthKeysBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(monthKeysBetween("2026-07", "2026-07")).toEqual(["2026-07"]);
    expect(monthKeysBetween("2026-08", "2026-07")).toEqual([]);
  });

  it("defaults to the current month, else the nearest tracked one", () => {
    const d = defaultExpenseData();
    expect(defaultMonthKey(d, "2026-07")).toBeNull(); // nothing tracked yet
    d.months = ["2026-05", "2026-06", "2026-07", "2026-08"].map((key) =>
      createMonthFromTemplates(d.templates, key),
    );
    expect(defaultMonthKey(d, "2026-07")).toBe("2026-07"); // today is tracked
    expect(defaultMonthKey(d, "2026-10")).toBe("2026-08"); // today past the list → latest
    expect(defaultMonthKey(d, "2026-03")).toBe("2026-05"); // list all in the future → first
  });

  it("proposes the month after the latest tracked one", () => {
    const d = defaultExpenseData();
    expect(nextMonthKey(d, "2026-07")).toBe("2026-07"); // empty → fallback (current month)
    d.months = [
      createMonthFromTemplates(d.templates, "2026-02"),
      createMonthFromTemplates(d.templates, "2026-01"),
    ];
    expect(nextMonthKey(d, "2026-07")).toBe("2026-03"); // after the latest, not the fallback
  });
});
