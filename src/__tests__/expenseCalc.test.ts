import { describe, expect, it } from "vitest";
import type {
  ExpenseData,
  ExpenseMonth,
  ExpenseTemplates,
  MonthExpenseItem,
} from "../model/expenseTypes";
import { defaultExpenseData } from "../model/expenseTypes";
import {
  addMonths,
  applyTemplatesToFutureMonths,
  applyTemplatesToMonth,
  createMonthFromTemplates,
  defaultMonthKey,
  futureMonths,
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

/** A deliberately tiny standard list so a resync is easy to read: expenses total
 *  1,330 and income 2,200, so every month's headroom is its start balance + 870.
 *  The figures are invented. */
function sampleTemplates(): ExpenseTemplates {
  return {
    expenses: [
      { id: "exp-rent", name: "Rent", day: 1, amount: 900, accountId: null },
      { id: "exp-gym", name: "Gym", day: 5, amount: 30, accountId: null },
      { id: "exp-isa", name: "ISA transfer", day: 28, amount: 400, accountId: "acc-isa" },
    ],
    income: [{ id: "inc-salary", name: "Salary", amount: 2200, accountId: null }],
  };
}

function dataWith(keys: string[], templates: ExpenseTemplates): ExpenseData {
  return { templates, months: keys.map((k) => createMonthFromTemplates(templates, k)) };
}

describe("future months", () => {
  it("counts only the months after the current one", () => {
    const d = dataWith(["2026-05", "2026-07", "2026-08", "2026-09"], sampleTemplates());
    // The current month (2026-07) is history in progress, not a forecast.
    expect(futureMonths(d, "2026-07").map((m) => m.key)).toEqual(["2026-08", "2026-09"]);
    expect(futureMonths(d, "2026-12")).toHaveLength(0);
  });
});

describe("pushing the standard items into one month", () => {
  it("resets a hand-edited line to the standard item", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09");
    Object.assign(m.expenses[0], {
      name: "Rent (renegotiated)",
      day: 15,
      amount: 5000,
      accountId: "acc-wrong",
    });
    const rent = applyTemplatesToMonth(t, m).expenses.find((e) => e.templateId === "exp-rent")!;
    expect(rent.amount).toBe(900);
    expect(rent.name).toBe("Rent");
    expect(rent.day).toBe(1);
    expect(rent.accountId).toBeNull();
  });

  it("drops deleted items, adds new ones, and keeps one-offs last", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09");
    m.expenses.push({
      id: "e1712",
      templateId: null,
      name: "Car repair",
      day: 9,
      amount: 320,
      paid: 0,
      accountId: null,
    });
    // Gym cancelled, vet plan started.
    const changed: ExpenseTemplates = {
      expenses: [
        t.expenses[0],
        t.expenses[2],
        { id: "exp-vet", name: "Vet plan", day: 20, amount: 25, accountId: null },
      ],
      income: t.income,
    };
    const out = applyTemplatesToMonth(changed, m);
    // Standard items in the standard order, then the month's own one-off.
    expect(out.expenses.map((e) => e.name)).toEqual(["Rent", "ISA transfer", "Vet plan", "Car repair"]);
    expect(out.expenses.find((e) => e.name === "Vet plan")!.paid).toBe(0);
  });

  it("treats a line saved before templateId existed as a one-off, not an orphan", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09");
    const legacy = { id: "old-1", name: "Legacy line", day: 3, amount: 12, paid: 0, accountId: null };
    m.expenses.push(legacy as unknown as MonthExpenseItem);
    expect(applyTemplatesToMonth(t, m).expenses.some((e) => e.name === "Legacy line")).toBe(true);
  });

  it("clamps paid to the new amount so 'to pay' can never go negative", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09");
    m.expenses[0].amount = 2000; // an invoice settled early, above the standard 900
    m.expenses[0].paid = 2000;
    m.expenses[1].paid = 10; // a genuine part-payment, below the standard 30
    const out = applyTemplatesToMonth(t, m);
    expect(out.expenses[0].paid).toBe(900);
    expect(out.expenses[1].paid).toBe(10);
    // Left at 2,000 this would report a negative to-pay and hide the warning.
    expect(summariseMonth(out).totalToPay).toBeGreaterThanOrEqual(0);
  });

  it("leaves the month's own facts alone and never aliases the templates", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09", 250);
    m.currentBalance = 640;
    const out = applyTemplatesToMonth(t, m);
    expect(out.key).toBe("2026-09");
    expect(out.startBalance).toBe(250);
    expect(out.currentBalance).toBe(640);
    expect(out.expenses.some((e) => (e as unknown) === (t.expenses[0] as unknown))).toBe(false);
  });
});

describe("pushing the standard items into every future month", () => {
  it("never rewrites the current month or the past", () => {
    const t = sampleTemplates();
    const d = dataWith(["2026-06", "2026-07", "2026-08"], t);
    d.months[0].startBalance = 123;
    for (const m of d.months) {
      m.expenses[0].amount = 5000;
      m.expenses[0].paid = 5000;
    }
    const out = applyTemplatesToFutureMonths(d, "2026-07");
    expect(out[0].expenses[0].amount).toBe(5000); // June: what actually happened
    expect(out[1].expenses[0].amount).toBe(5000); // July: the current month
    expect(out[2].expenses[0].amount).toBe(900); // August: resynced
    expect(out[0].startBalance).toBe(123); // the past is not re-chained either
  });

  it("re-chains future start balances from the month before", () => {
    const t = sampleTemplates();
    const d = dataWith(["2026-07", "2026-08", "2026-09"], t);
    d.months[0].startBalance = 500;
    const out = applyTemplatesToFutureMonths(d, "2026-07");
    expect(out[0].startBalance).toBe(500); // the current month is the anchor
    expect(out[1].startBalance).toBeCloseTo(1370, 2); // 500 + 870
    expect(out[2].startBalance).toBeCloseTo(2240, 2); // 1370 + 870
  });

  it("keeps the opening balance of the first tracked month", () => {
    const t = sampleTemplates();
    const d = dataWith(["2026-08", "2026-09"], t); // the whole list lies ahead
    d.months[0].startBalance = 1500;
    const out = applyTemplatesToFutureMonths(d, "2026-07");
    expect(out[0].startBalance).toBe(1500); // nothing to chain from — user-entered
    expect(out[1].startBalance).toBeCloseTo(2370, 2); // 1500 + 870
  });

  it("is idempotent — a second push changes nothing", () => {
    const t = sampleTemplates();
    const d = dataWith(["2026-07", "2026-08", "2026-09"], t);
    d.months[2].expenses[0].amount = 4321; // a hand-edit to wash out
    const once = applyTemplatesToFutureMonths(d, "2026-07");
    const twice = applyTemplatesToFutureMonths({ templates: t, months: once }, "2026-07");
    expect(twice).toEqual(once);
  });
});
