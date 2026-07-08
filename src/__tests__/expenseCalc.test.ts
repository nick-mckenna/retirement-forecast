import { describe, expect, it } from "vitest";
import type { ExpenseMonth } from "../model/expenseTypes";
import { defaultExpenseData } from "../model/expenseTypes";
import {
  addMonths,
  createMonthFromTemplates,
  isMonthKey,
  monthLabel,
  monthWarnings,
  nextMonthKey,
  summariseMonth,
} from "../expenses/calc";

/** January 2026 exactly as recorded in Expenditure2026.xlsx (the golden reference). */
function january2026(): ExpenseMonth {
  const e = (name: string, day: number | null, amount: number, paid: number) => ({
    id: `2026-01:${name}`,
    templateId: null,
    name,
    day,
    amount,
    paid,
  });
  const inc = (name: string, amount: number) => ({
    id: `2026-01:${name}`,
    templateId: null,
    name,
    amount,
  });
  return {
    key: "2026-01",
    startBalance: 332.52,
    currentBalance: 714.41,
    expenses: [
      e("Savings / Investments", 30, 8000, 8000),
      e("BA Amex Nick", 13, 1604.59, 1604.59),
      e("BA Amex Tracy", 6, 6661.04, 6661.04),
      e("Natwest / Sainsburys", 15, 10.99, 10.99),
      e("Barclaycard", 8, 1754.79, 1754.79),
      e("Council Tax", 1, 291, 291),
      e("Cleaner", null, 258, 258),
      e("Octopus Energy", 12, 225.47, 225.47),
      e("Bupa", 9, 133.2, 133.2),
      e("EE (Hotspot & Nick)", 5, 79.61, 79.61),
      e("Water", 1, 60, 60),
      e("yayzi", 31, 39, 0),
      e("EE Limited (Tracy)", 15, 32.17, 32.17),
      e("Denplan Nick", 1, 26.1, 26.1),
      e("Lottery", 19, 22.5, 22.5),
      e("Aviva", 1, 20.97, 20.97),
      e("Bank Fee", 27, 15, 15),
    ],
    income: [
      inc("Savings", 500),
      inc("Raworths Salary", 2791.65),
      inc("MCL Salaries", 1567.49),
      inc("MCL Divs", 8750),
      inc("Expenses", 5714.21),
    ],
  };
}

describe("month summary (golden values from Expenditure2026.xlsx)", () => {
  it("reproduces January 2026", () => {
    const s = summariseMonth(january2026());
    expect(s.totalExpenses).toBeCloseTo(19234.43, 2); // sheet B22
    expect(s.totalPaid).toBeCloseTo(19195.43, 2); // sheet E22
    expect(s.totalToPay).toBeCloseTo(39, 2); // sheet D22
    expect(s.totalAvailable).toBeCloseTo(19655.87, 2); // sheet B31 (incl. start balance)
    expect(s.headroom).toBeCloseTo(421.44, 2); // sheet B33 "Balance To Reach 0"
    expect(s.predicted).toBeCloseTo(675.41, 2); // sheet C36 "Predicted"
  });

  it("flags a month whose expenses exceed the money coming in (March 2026)", () => {
    // March 2026: expenses total 11,028.65 vs start 750 + income 10,148.96.
    const m = january2026();
    m.key = "2026-03";
    m.expenses = [
      { id: "x", templateId: null, name: "Everything", day: null, amount: 11028.65, paid: 3470.43 },
    ];
    m.startBalance = 750;
    m.income = [{ id: "i", templateId: null, name: "All income", amount: 10148.96 }];
    m.currentBalance = 8316.16;
    const s = summariseMonth(m);
    expect(s.headroom).toBeCloseTo(-129.69, 2); // sheet B33, negative
    expect(s.predicted).toBeCloseTo(757.94, 2); // sheet C36 — fine because savings top it up
    const w = monthWarnings(m);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("below zero");
  });

  it("warns when remaining payments exceed the current balance", () => {
    const m = january2026();
    m.currentBalance = 20; // 39 still to pay
    const w = monthWarnings(m);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("top the account up");
  });

  it("leaves predicted null until a current balance is entered", () => {
    const m = january2026();
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
    const octopus = m.expenses.find((e) => e.name === "Octopus Energy")!;
    expect(octopus.amount).toBe(226.62);
    expect(octopus.day).toBe(12);
    expect(octopus.templateId).toBe("exp-octopus");
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
