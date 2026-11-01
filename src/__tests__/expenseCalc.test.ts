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
  fillMissingMonths,
  futureMonths,
  isMonthKey,
  monthKeysBetween,
  monthLabel,
  monthWarnings,
  nextMonthKey,
  rechainStartBalances,
  resolveLegacyPins,
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
    received: amount,
    accountId: null,
  });
  return {
    key: "2026-01",
    startBalance: 500,
    startBalancePinned: true,
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
    m.income = [{ id: "i", templateId: null, name: "All income", amount: 4300, received: 4300, accountId: null }];
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

  it("returns no months (rather than looping forever) for a malformed key", () => {
    // "NaN-NaN" is what an empty start date used to turn into; it sorts after every real key.
    expect(monthKeysBetween("2026-07", "NaN-NaN")).toEqual([]);
    expect(monthKeysBetween("", "2026-07")).toEqual([]);
    expect(monthKeysBetween("2026-07", "2026-13")).toEqual([]);
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

  it("keeps what was paid (a fact) and never reports a negative 'to pay'", () => {
    const t = sampleTemplates();
    const m = createMonthFromTemplates(t, "2026-09");
    m.expenses[0].amount = 2000; // an invoice settled early, above the standard 900
    m.expenses[0].paid = 2000;
    m.expenses[1].paid = 10; // a genuine part-payment, below the standard 30
    m.income[0].received = 1000;
    const out = applyTemplatesToMonth(t, m);
    expect(out.expenses[0].paid).toBe(2000);
    expect(out.expenses[1].paid).toBe(10);
    expect(out.income[0].received).toBe(1000);
    const s = summariseMonth(out);
    expect(s.totalToPay).toBeCloseTo(0 + 20 + 400, 2); // the overpaid line has nothing left, not −1,100
    // Out goes at what was actually paid where that is more: 2,000 + 30 + 400.
    expect(s.headroom).toBeCloseTo(2200 - 2430, 2);
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

describe("received income and per-line clamping", () => {
  function month(): ExpenseMonth {
    return {
      key: "2026-04",
      startBalance: 300,
      startBalancePinned: true,
      currentBalance: 1000,
      expenses: [
        { id: "a", templateId: null, name: "Rent", day: 1, amount: 900, paid: 900, accountId: null },
        { id: "b", templateId: null, name: "Energy", day: 12, amount: 150, paid: 0, accountId: null },
        { id: "c", templateId: null, name: "Insurance", day: 3, amount: 50, paid: 80, accountId: null },
      ],
      income: [
        { id: "s", templateId: null, name: "Salary", amount: 2000, received: 2000, accountId: null },
        { id: "d", templateId: null, name: "Dividends", amount: 400, received: 0, accountId: null },
        { id: "r", templateId: null, name: "Refund", amount: 0, received: 25, accountId: null },
      ],
    };
  }

  it("counts what is still to pay and still to come per line", () => {
    const s = summariseMonth(month());
    expect(s.totalToPay).toBe(150); // the 80-paid 50 line adds 0, not −30
    expect(s.totalReceived).toBe(2025);
    expect(s.totalToReceive).toBe(400);
  });

  it("expects the larger of expected and actual on each line", () => {
    const s = summariseMonth(month());
    expect(s.totalAvailable).toBe(300 + 2000 + 400 + 25);
    expect(s.headroom).toBe(2725 - (900 + 150 + 80));
  });

  it("predicts the month end from the bank balance, the bills to come and the income to come", () => {
    expect(summariseMonth(month()).predicted).toBe(1000 - 150 + 400);
  });

  it("keeps the spreadsheet figures when every income line is fully received", () => {
    const m = month();
    for (const i of m.income) i.received = i.amount;
    const s = summariseMonth(m);
    expect(s.totalToReceive).toBe(0);
    expect(s.predicted).toBe(1000 - 150);
  });
});

describe("carried-forward start balances", () => {
  const t = (): ExpenseTemplates => ({
    expenses: [{ id: "x", name: "Bills", day: 1, amount: 1000, accountId: null }],
    income: [{ id: "y", name: "Pay", amount: 1200, accountId: null }],
  });

  it("follow an edit to an earlier month, one pass, stopping at a pinned month", () => {
    const months = ["2026-01", "2026-02", "2026-03", "2026-04"].map((k) => createMonthFromTemplates(t(), k));
    months[0].startBalance = 100;
    months[0].startBalancePinned = true;
    months[2].startBalance = 5000;
    months[2].startBalancePinned = true; // typed: a fact
    const { months: out, changed } = rechainStartBalances(months);
    expect(out.map((m) => m.startBalance)).toEqual([100, 300, 5000, 5200]);
    expect(changed).toEqual(["2026-02", "2026-04"]);
  });

  it("don't carry across a gap in the tracked months", () => {
    const months = ["2026-01", "2026-03"].map((k) => createMonthFromTemplates(t(), k, 50));
    expect(rechainStartBalances(months).months.map((m) => m.startBalance)).toEqual([50, 50]);
  });

  it("report nothing changed when the chain already holds", () => {
    const months = ["2026-01", "2026-02"].map((k) => createMonthFromTemplates(t(), k));
    months[1].startBalance = 200;
    expect(rechainStartBalances(months).changed).toEqual([]);
  });

  it("legacy months are pinned unless they equal the chained value", () => {
    const months = ["2026-01", "2026-02", "2026-03", "2026-05"].map((k) => createMonthFromTemplates(t(), k));
    months[0].startBalance = 100;
    months[1].startBalance = 300; // = 100 + 200: carried forward
    months[2].startBalance = 999; // typed
    months[3].startBalance = 1; // after a gap
    const out = resolveLegacyPins(months, () => true);
    expect(out.map((m) => m.startBalancePinned)).toEqual([true, false, true, true]);
  });
});

describe("filling missing months", () => {
  it("adds gaps and months before the first, carrying start balances forward", () => {
    const tt: ExpenseTemplates = {
      expenses: [{ id: "x", name: "Bills", day: 1, amount: 1000, accountId: null }],
      income: [{ id: "y", name: "Pay", amount: 1200, accountId: null }],
    };
    const d: ExpenseData = { templates: tt, months: ["2026-03", "2026-05"].map((k) => createMonthFromTemplates(tt, k)) };
    d.months[0].startBalance = 400;
    d.months[0].startBalancePinned = true;
    const { months, added } = fillMissingMonths(d, "2026-02", "2026-06");
    expect(added).toEqual(["2026-02", "2026-04", "2026-06"]);
    expect(months.map((m) => m.key)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    expect(months.map((m) => m.startBalance)).toEqual([0, 400, 600, 800, 1000]);
  });

  it("adds nothing when every month is tracked or the keys are invalid", () => {
    const d = dataWith(["2026-01", "2026-02"], sampleTemplates());
    expect(fillMissingMonths(d, "2026-01", "2026-02").added).toEqual([]);
    expect(fillMissingMonths(d, "", "2026-05").added).toEqual([]);
  });
});
