import { describe, expect, it } from "vitest";
import type { ExpenseMonth } from "../model/expenseTypes";
import type { InvestmentAccount, PreRetirementData } from "../model/preRetirementTypes";
import { defaultPreRetirementData } from "../model/preRetirementTypes";
import { annualToMonthly, grow } from "../model/rates";
import { defaultScenario } from "../model/defaults";
import { migratePreRetirementData, migrateScenario } from "../model/migrate";
import {
  balancesAtDate,
  sampleAtDate,
  latestActualTotal,
  latestOverride,
  overrideDateIso,
  projectAccounts,
  ratesForKinds,
  type KindRates,
} from "../preretirement/project";
import {
  handoffMonthKey,
  resolveLinkedBalances,
  resolveScenarioForRun,
} from "../preretirement/link";
import { allowanceWarnings, taxYearOfDay } from "../preretirement/allowances";
import { monthKeysBetween } from "../expenses/calc";

const RATES: KindRates = {
  isa: 0.07,
  pension: 0.07,
  gia: 0.07,
  savings: 0.035,
  premiumBonds: 0.045,
  gilts: 0.04,
};

function account(partial: Partial<InvestmentAccount> & { id: string }): InvestmentAccount {
  return {
    name: partial.id,
    owner: "nick",
    kind: "savings",
    openingBalance: 0,
    openingGainFraction: null,
    reliefAtSource: false,
    externalMonthlyContribution: 0,
    maturityYear: null,
    giltPayout: "account",
    ...partial,
  };
}

function data(accounts: InvestmentAccount[], openingMonth = "2026-07"): PreRetirementData {
  return { openingMonth, accounts, overrides: [], giltLots: [] };
}

/** A bare expense month containing only the given tagged lines
 *  ([accountId, amount, paid?, dueDay?] — dueDay defaults to undated). */
function month(
  key: string,
  lines: { expense?: [string, number, number?, (number | null)?][]; income?: [string, number][] } = {},
): ExpenseMonth {
  return {
    key,
    startBalance: 0,
    startBalancePinned: false,
    currentBalance: null,
    expenses: (lines.expense ?? []).map(([accountId, amount, paid, day], i) => ({
      id: `${key}:e${i}`,
      templateId: null,
      name: `line ${i}`,
      day: day ?? null,
      amount,
      paid: paid ?? 0,
      accountId,
    })),
    income: (lines.income ?? []).map(([accountId, amount], i) => ({
      id: `${key}:i${i}`,
      templateId: null,
      name: `inc ${i}`,
      amount,
      received: amount,
      accountId,
    })),
  };
}

describe("projectAccounts — growth", () => {
  it("compounds each account at its kind's monthly rate: a full year matches grow()", () => {
    const d = data(
      [
        account({ id: "isa1", kind: "isa", openingBalance: 10000 }),
        account({ id: "pb1", kind: "premiumBonds", openingBalance: 5000 }),
        account({ id: "gilts1", owner: "tracy", kind: "gilts", openingBalance: 20000 }),
        account({ id: "empty", kind: "savings" }),
      ],
      "2026-01",
    );
    const r = projectAccounts(d, [], RATES, "2026-12");
    expect(r.months).toHaveLength(12);
    const last = r.months[11];
    expect(last.byAccount["isa1"].end).toBeCloseTo(grow(10000, 0.07, 1), 6);
    expect(last.byAccount["pb1"].end).toBeCloseTo(grow(5000, 0.045, 1), 6);
    expect(last.byAccount["gilts1"].end).toBeCloseTo(grow(20000, 0.04, 1), 6);
    expect(last.byAccount["empty"].end).toBe(0);
  });

  it("maps scenario rates onto kinds (inv/inv/inv/sav/prize; gilts at nominal)", () => {
    const k = ratesForKinds(defaultScenario().rates);
    expect(k.isa).toBe(0.07);
    expect(k.pension).toBe(0.07);
    expect(k.gia).toBe(0.07);
    expect(k.savings).toBe(0.035);
    expect(k.premiumBonds).toBe(0.035);
    expect(k.gilts).toBe(0); // held at nominal before retirement: coupons aren't modelled here
  });

  it("applies growth before the month's flows (contributions earn nothing in their month)", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["isa1", 500]] })], RATES, "2026-07");
    const cell = r.months[0].byAccount["isa1"];
    expect(cell.growth).toBeCloseTo(1000 * annualToMonthly(0.07), 10);
    expect(cell.contributions).toBe(500);
    expect(cell.end).toBeCloseTo(1000 + cell.growth + 500, 10);
  });
});

describe("projectAccounts — flows from tagged lines", () => {
  it("uses the expected amount, never paid", () => {
    const d = data([account({ id: "sav1" })]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["sav1", 2000, 750]] })], RATES, "2026-07");
    expect(r.months[0].byAccount["sav1"].contributions).toBe(2000);
  });

  it("treats tagged income lines as withdrawals from the account", () => {
    const d = data([account({ id: "pb1", kind: "premiumBonds", openingBalance: 10000 })]);
    const r = projectAccounts(d, [month("2026-07", { income: [["pb1", 3000]] })], RATES, "2026-07");
    const cell = r.months[0].byAccount["pb1"];
    expect(cell.withdrawals).toBe(3000);
    expect(cell.end).toBeCloseTo(10000 + cell.growth - 3000, 10);
  });

  it("sums multiple lines tagged to the same account in one month", () => {
    const d = data([account({ id: "isa1", kind: "isa" })]);
    const r = projectAccounts(
      d,
      [month("2026-07", { expense: [["isa1", 500], ["isa1", 250]] })],
      RATES,
      "2026-07",
    );
    expect(r.months[0].byAccount["isa1"].contributions).toBe(750);
  });

  it("keeps two same-kind accounts separate (e.g. two pensions)", () => {
    const d = data([
      account({ id: "sipp-pension", kind: "pension", openingBalance: 1000 }),
      account({ id: "workplace-pension", kind: "pension", openingBalance: 2000 }),
    ]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["workplace-pension", 300]] })], RATES, "2026-07");
    expect(r.months[0].byAccount["sipp-pension"].contributions).toBe(0);
    expect(r.months[0].byAccount["workplace-pension"].contributions).toBe(300);
  });

  it("ignores tags for unknown/deleted accounts and reports them", () => {
    const d = data([account({ id: "sav1" })]);
    const r = projectAccounts(
      d,
      [month("2026-07", { expense: [["deleted-account", 500]] })],
      RATES,
      "2026-07",
    );
    expect(r.unknownAccountIds).toEqual(["deleted-account"]);
    expect(r.months[0].total).toBe(0);
    expect(r.warnings.some((w) => w.includes("unknown/deleted account"))).toBe(true);
  });

  it("ignores tagged flows before the opening month, with a warning", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    const r = projectAccounts(d, [month("2026-06", { expense: [["isa1", 500]] })], RATES, "2026-07");
    expect(r.months[0].byAccount["isa1"].contributions).toBe(0);
    expect(r.warnings.some((w) => w.includes("before the opening month"))).toBe(true);
  });

  it("drops duplicate account ids with a warning", () => {
    const d = data([
      account({ id: "dup", openingBalance: 100 }),
      account({ id: "dup", openingBalance: 999 }),
    ]);
    const r = projectAccounts(d, [], RATES, "2026-07");
    expect(r.months[0].byAccount["dup"].start).toBe(100);
    expect(r.warnings.some((w) => w.includes("Duplicate account id"))).toBe(true);
  });
});

describe("projectAccounts — balance overrides", () => {
  it("replaces the month-end balance and compounds the following months from it", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-08", day: null, value: 9000, basis: null }];
    const r = projectAccounts(d, [], RATES, "2026-09");
    expect(r.months[1].byAccount["isa1"].end).toBe(9000);
    expect(r.months[1].byAccount["isa1"].recorded).toEqual({ day: null, value: 9000, basis: null });
    const sep = r.months[2].byAccount["isa1"];
    expect(sep.start).toBe(9000);
    expect(sep.end).toBeCloseTo(9000 * (1 + annualToMonthly(0.07)), 10);
    expect(sep.recorded).toBeNull();
  });

  it("re-anchors mid-month and pro-rates the rest of the month's growth by calendar days", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-08", day: 10, value: 9000, basis: null }];
    const r = projectAccounts(d, [], RATES, "2026-09");
    const aug = r.months[1].byAccount["isa1"];
    const expectedEnd = 9000 * Math.pow(1 + annualToMonthly(0.07), (31 - 10) / 31);
    expect(aug.recorded).toEqual({ day: 10, value: 9000, basis: null });
    expect(aug.growth).toBeCloseTo(expectedEnd - 9000, 10);
    expect(aug.end).toBeCloseTo(expectedEnd, 10);
    expect(r.months[2].byAccount["isa1"].start).toBeCloseTo(expectedEnd, 10);
  });

  it("still adds contributions due after the recorded day; earlier and undated ones are inside the balance", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-07", day: 10, value: 2000, basis: null }];
    const m = month("2026-07", {
      expense: [
        ["isa1", 500, 0, 5], // due before the record — absorbed
        ["isa1", 300, 0, 25], // due after — still to come
        ["isa1", 200], // undated — assumed absorbed
      ],
    });
    const r = projectAccounts(d, [m], RATES, "2026-07");
    const cell = r.months[0].byAccount["isa1"];
    expect(cell.contributions).toBe(300);
    expect(cell.end).toBeCloseTo(2000 * Math.pow(1 + annualToMonthly(0.07), (31 - 10) / 31) + 300, 10);
  });

  it("assumes tagged income (no due day) is already inside a mid-month recorded balance", () => {
    const d = data([account({ id: "pb1", kind: "premiumBonds", openingBalance: 10000 })]);
    d.overrides = [{ accountId: "pb1", monthKey: "2026-07", day: 10, value: 5000, basis: null }];
    const r = projectAccounts(d, [month("2026-07", { income: [["pb1", 3000]] })], RATES, "2026-07");
    const cell = r.months[0].byAccount["pb1"];
    expect(cell.withdrawals).toBe(0);
    expect(cell.end).toBeCloseTo(5000 * Math.pow(1 + annualToMonthly(0.045), (31 - 10) / 31), 10);
  });

  it("treats a day at or past the month's last day as end of month (≡ day null)", () => {
    const d = data([
      account({ id: "a31", kind: "isa", openingBalance: 1000 }),
      account({ id: "aNull", kind: "isa", openingBalance: 1000 }),
    ]);
    d.overrides = [
      { accountId: "a31", monthKey: "2026-09", day: 31, value: 900, basis: null }, // September has 30 days
      { accountId: "aNull", monthKey: "2026-09", day: null, value: 900, basis: null },
    ];
    const r = projectAccounts(d, [], RATES, "2026-09");
    const sep = r.months[2];
    expect(sep.byAccount["a31"].end).toBe(900);
    expect(sep.byAccount["a31"].growth).toBe(0);
    expect(sep.byAccount["a31"].end).toBe(sep.byAccount["aNull"].end);
  });

  it("anchors on the latest record when a month has several (null day = end of month wins)", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-08", day: 20, value: 9500, basis: null },
      { accountId: "isa1", monthKey: "2026-08", day: 10, value: 9000, basis: null },
    ];
    const r = projectAccounts(d, [], RATES, "2026-08");
    const aug = r.months[1].byAccount["isa1"];
    expect(aug.recorded).toEqual({ day: 20, value: 9500, basis: null });
    expect(aug.end).toBeCloseTo(9500 * Math.pow(1 + annualToMonthly(0.07), (31 - 20) / 31), 10);

    d.overrides.push({ accountId: "isa1", monthKey: "2026-08", day: null, value: 9800, basis: null });
    const r2 = projectAccounts(d, [], RATES, "2026-08");
    expect(r2.months[1].byAccount["isa1"].end).toBe(9800);
  });

  it("ignores overrides before the opening month or for unknown accounts, with warnings", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-01", day: null, value: 5, basis: null },
      { accountId: "ghost", monthKey: "2026-07", day: null, value: 5, basis: null },
    ];
    const r = projectAccounts(d, [], RATES, "2026-07");
    expect(r.months[0].byAccount["isa1"].end).not.toBe(5);
    expect(r.warnings.some((w) => w.includes("before the opening month and is ignored"))).toBe(true);
    expect(r.warnings.some((w) => w.includes('unknown account "ghost"'))).toBe(true);
  });
});

describe("projectAccounts — GIA cost basis", () => {
  it("seeds basis per GIA account from its gain fraction and grows it with contributions", () => {
    const d = data([account({ id: "gia1", kind: "gia", openingBalance: 10000, openingGainFraction: 0.3 })]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["gia1", 1000]] })], RATES, "2026-07");
    expect(r.months[0].basis["gia1"]).toBeCloseTo(8000, 10);
  });

  it("reduces basis proportionally on withdrawals; growth never changes it", () => {
    const d = data([account({ id: "gia1", kind: "gia", openingBalance: 10000, openingGainFraction: 0.2 })]);
    const r = projectAccounts(d, [month("2026-07", { income: [["gia1", 5000]] })], RATES, "2026-07");
    const cell = r.months[0].byAccount["gia1"];
    const valueBefore = 10000 + cell.growth;
    const expectedBasis = 8000 - 5000 * (8000 / valueBefore);
    expect(r.months[0].basis["gia1"]).toBeCloseTo(expectedBasis, 8);
  });

  it("missing months in range are reported and treated as zero flows", () => {
    const d = data([account({ id: "sav1", openingBalance: 100 })]);
    const r = projectAccounts(d, [month("2026-08")], RATES, "2026-10");
    expect(r.missingMonthKeys).toEqual(["2026-07", "2026-09", "2026-10"]);
    expect(r.warnings.some((w) => w.includes("no expense record"))).toBe(true);
  });
});

describe("latestOverride", () => {
  it("picks the latest-dated record with the engine's ordering (null day = end of month, later entries win ties)", () => {
    const d = data([account({ id: "isa1" })]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-08", day: 20, value: 2, basis: null },
      { accountId: "other", monthKey: "2026-12", day: 1, value: 99, basis: null },
      { accountId: "isa1", monthKey: "2026-08", day: null, value: 3, basis: null },
      { accountId: "isa1", monthKey: "2026-07", day: 8, value: 1, basis: null },
    ];
    expect(latestOverride(d, "isa1")?.value).toBe(3); // end of August beats 20 August
    d.overrides.push({ accountId: "isa1", monthKey: "2026-08", day: null, value: 4, basis: null });
    expect(latestOverride(d, "isa1")?.value).toBe(4); // later entry wins the tie
    expect(latestOverride(d, "ghost")).toBeNull();
  });
});

describe("latestActualTotal", () => {
  it("sums each account's latest recorded balance, with no growth or flows", () => {
    const d = data([
      account({ id: "isa1", kind: "isa", openingBalance: 10000 }),
      account({ id: "sav1", openingBalance: 5000 }),
    ]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-07", day: 8, value: 11000, basis: null },
      { accountId: "isa1", monthKey: "2026-08", day: 20, value: 12000, basis: null },
      { accountId: "sav1", monthKey: "2026-08", day: null, value: 4500, basis: null },
    ];
    expect(latestActualTotal(d)).toEqual({
      total: 16500, // 12000 + 4500 — the latest record each, nothing projected
      latestDate: "2026-08-31", // sav1's end-of-August record is the most recent
      recordedCount: 2,
      openingCount: 0,
    });
  });

  it("falls back to the opening balance for accounts with no record", () => {
    const d = data([
      account({ id: "isa1", kind: "isa", openingBalance: 10000 }),
      account({ id: "sav1", openingBalance: 5000 }),
    ]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-08", day: 20, value: 12000, basis: null }];
    expect(latestActualTotal(d)).toEqual({
      total: 17000, // 12000 recorded + 5000 opening
      latestDate: "2026-08-20",
      recordedCount: 1,
      openingCount: 1,
    });
    expect(latestActualTotal(data([]))).toEqual({
      total: 0,
      latestDate: null,
      recordedCount: 0,
      openingCount: 0,
    });
  });

  it("counts a duplicated account id once, like the engine", () => {
    const d = data([account({ id: "sav1", openingBalance: 5000 }), account({ id: "sav1", openingBalance: 9000 })]);
    expect(latestActualTotal(d).total).toBe(5000);
    expect(latestActualTotal(d).openingCount).toBe(1);
  });
});

describe("overrideDateIso", () => {
  it("resolves a null day to the month end and clamps overlong days", () => {
    expect(overrideDateIso({ monthKey: "2026-02", day: null })).toBe("2026-02-28");
    expect(overrideDateIso({ monthKey: "2026-04", day: 31 })).toBe("2026-04-30");
    expect(overrideDateIso({ monthKey: "2026-08", day: 5 })).toBe("2026-08-05");
  });
});

describe("balancesAtDate", () => {
  const monthlyRate = annualToMonthly(0.07);

  it("pro-rates growth to the end of the given day; the month's last day equals the cell end", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    const r = projectAccounts(d, [], RATES, "2026-09");
    const aug = r.months[1].byAccount["isa1"];
    expect(balancesAtDate(r, d, [], RATES, "2026-08-10")["isa1"]).toBeCloseTo(
      aug.start * Math.pow(1 + monthlyRate, 10 / 31),
      10,
    );
    expect(balancesAtDate(r, d, [], RATES, "2026-08-31")["isa1"]).toBeCloseTo(aug.end, 10);
  });

  it("includes only the flows due by the date (undated lines and income at the start of the month)", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    const months = [
      month("2026-07", {
        expense: [
          ["isa1", 500, 0, 5], // due by the 10th — included
          ["isa1", 300, 0, 25], // due later — not yet
          ["isa1", 200], // undated — treated as start of month
        ],
        income: [["isa1", 100]], // no due day — gone from the start
      }),
    ];
    const r = projectAccounts(d, months, RATES, "2026-07");
    const growth = 1000 * (Math.pow(1 + monthlyRate, 10 / 31) - 1);
    expect(balancesAtDate(r, d, months, RATES, "2026-07-10")["isa1"]).toBeCloseTo(
      1000 + growth + 500 + 200 - 100,
      10,
    );
  });

  it("re-anchors at the latest record on or before the date and ignores later ones", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-07", day: 8, value: 9000, basis: null },
      { accountId: "isa1", monthKey: "2026-07", day: 20, value: 9500, basis: null },
    ];
    const r = projectAccounts(d, [], RATES, "2026-07");
    // Before the first record: projected from the month start.
    expect(balancesAtDate(r, d, [], RATES, "2026-07-05")["isa1"]).toBeCloseTo(
      10000 * Math.pow(1 + monthlyRate, 5 / 31),
      10,
    );
    // Between the records: anchored on the day-8 one.
    expect(balancesAtDate(r, d, [], RATES, "2026-07-15")["isa1"]).toBeCloseTo(
      9000 * Math.pow(1 + monthlyRate, 7 / 31),
      10,
    );
    // On the later record and at the month end: anchored on it, matching the cell.
    expect(balancesAtDate(r, d, [], RATES, "2026-07-20")["isa1"]).toBe(9500);
    expect(balancesAtDate(r, d, [], RATES, "2026-07-31")["isa1"]).toBeCloseTo(
      r.months[0].byAccount["isa1"].end,
      10,
    );
  });

  it("treats an end-of-month record as landing on the month's last day", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-07", day: null, value: 9000, basis: null }];
    const r = projectAccounts(d, [], RATES, "2026-07");
    expect(balancesAtDate(r, d, [], RATES, "2026-07-30")["isa1"]).toBeCloseTo(
      10000 * Math.pow(1 + monthlyRate, 30 / 31), // not anchored yet
      10,
    );
    expect(balancesAtDate(r, d, [], RATES, "2026-07-31")["isa1"]).toBe(9000);
  });

  it("clamps to the projection range", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    const r = projectAccounts(d, [], RATES, "2026-09");
    expect(balancesAtDate(r, d, [], RATES, "2026-01-15")["isa1"]).toBe(1000); // before → opening
    expect(balancesAtDate(r, d, [], RATES, "2030-01-15")["isa1"]).toBe(r.months[2].byAccount["isa1"].end); // after → last
    expect(balancesAtDate({ ...r, months: [] }, d, [], RATES, "2026-08-15")).toEqual({});
  });
});

describe("handoff to the retirement forecast", () => {
  it("projects through the startDate's own month (the handoff is the end of that day)", () => {
    expect(handoffMonthKey("2033-04-05")).toBe("2033-04");
    expect(handoffMonthKey("2028-01-01")).toBe("2028-01");
  });

  it("aggregates accounts by owner and kind: pensions sum, premium bonds keep their own pot, gilts flow", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-10-05"; // handoff: end of 5 October (3 months + 5/31 of October)
    const d = data([
      account({ id: "n-isa", kind: "isa", openingBalance: 100 }),
      account({ id: "n-pen-1", kind: "pension", openingBalance: 200 }),
      account({ id: "n-pen-2", kind: "pension", openingBalance: 300 }),
      account({ id: "n-gia", kind: "gia", openingBalance: 10000, openingGainFraction: 0.3 }),
      account({ id: "n-sav", kind: "savings", openingBalance: 400 }),
      account({ id: "n-pb", kind: "premiumBonds", openingBalance: 50 }),
      account({ id: "n-gilts", kind: "gilts", openingBalance: 600 }),
    ]);
    const { balances, warnings } = resolveLinkedBalances(scenario, d, []);
    const kinds = ratesForKinds(scenario.rates);
    const at = (v: number, rate: number) => grow(v, rate, 3 / 12) * (1 + annualToMonthly(rate)) ** (5 / 31);
    expect(balances.nick.isa).toBeCloseTo(at(100, kinds.isa), 6);
    expect(balances.nick.pension).toBeCloseTo(at(200 + 300, kinds.pension), 6);
    expect(balances.nick.savings).toBeCloseTo(at(400, kinds.savings), 6);
    expect(balances.nick.premiumBonds).toBeCloseTo(at(50, kinds.premiumBonds), 6);
    expect(balances.nick.gilts).toBeCloseTo(at(600, kinds.gilts), 6);
    // Basis stays 7000 while the value grows, so the gain fraction rises.
    const gia = at(10000, kinds.gia);
    expect(balances.nick.gia).toBeCloseTo(gia, 6);
    expect(balances.nick.giaGainFraction).toBeCloseTo((gia - 7000) / gia, 8);
    expect(balances.tracy.pension).toBe(0);
    expect(warnings.some((w) => w.includes("no expense record"))).toBe(true); // months not tracked
  });

  it("falls back to manual balances when there are no accounts", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    const { balances, warnings } = resolveLinkedBalances(scenario, data([]), []);
    expect(balances).toEqual(scenario.balances);
    expect(warnings[0]).toContain("no accounts");
  });

  it("falls back to manual balances when the scenario starts before the opening month", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-05-01";
    const { balances, warnings } = resolveLinkedBalances(scenario, data([account({ id: "a" })]), []);
    expect(balances).toEqual(scenario.balances);
    expect(warnings[0]).toContain("manual balances");
  });

  it("resolveScenarioForRun is the identity when the link is off", () => {
    const scenario = defaultScenario();
    const { scenario: out, warnings } = resolveScenarioForRun(scenario, data([account({ id: "a" })]), []);
    expect(out).toBe(scenario);
    expect(warnings).toEqual([]);
  });

  it("resolveScenarioForRun swaps in projected balances when linked", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-09-05";
    const d = data([account({ id: "t-pb", owner: "tracy", kind: "premiumBonds", openingBalance: 1000 })]);
    const { scenario: out } = resolveScenarioForRun(scenario, d, []);
    expect(out).not.toBe(scenario);
    const pb = scenario.rates.premiumBondRate;
    expect(out.balances.tracy.premiumBonds).toBeCloseTo(grow(1000, pb, 2 / 12) * (1 + annualToMonthly(pb)) ** (5 / 30), 6);
    expect(out.balances.tracy.savings).toBe(0);
    expect(out.balances.nick.isa).toBe(0); // projection replaces ALL pots, not just tagged ones
  });
});

describe("pre-retirement data migration", () => {
  it("backfills structures missing from newer-shape saves", () => {
    const sparse = {
      openingMonth: "2026-07",
      accounts: [{ id: "a", name: "A", owner: "nick", kind: "isa" }],
      overrides: [{ accountId: "a", monthKey: "2026-08", value: 42 }], // pre-day save
    } as unknown as PreRetirementData;
    const d = migratePreRetirementData(sparse);
    expect(d.accounts[0].openingBalance).toBe(0);
    expect(d.accounts[0].openingGainFraction).toBeNull();
    expect(d.overrides).toEqual([{ accountId: "a", monthKey: "2026-08", day: null, value: 42, basis: null }]);
    expect(migratePreRetirementData({ ...sparse, overrides: undefined } as unknown as PreRetirementData).overrides).toEqual([]);
  });

  it("upgrades legacy fixed-pot saves into registry accounts (ids keep old tag form)", () => {
    const legacy = {
      openingMonth: "2026-07",
      pots: {
        nick: { isa: 1000, pension: 0, gia: 5000, savings: 0, premiumBonds: 0, gilts: 0 },
        tracy: { isa: 0, pension: 0, gia: 0, savings: 200, premiumBonds: 0, gilts: 0 },
      },
      giaGainFraction: { nick: 0.25, tracy: 0 },
      overrides: [{ person: "tracy", kind: "premiumBonds", monthKey: "2026-08", value: 42 }],
    } as unknown as PreRetirementData;
    const d = migratePreRetirementData(legacy);
    const ids = d.accounts.map((a) => a.id).sort();
    expect(ids).toEqual(["nick:gia", "nick:isa", "tracy:premiumBonds", "tracy:savings"]);
    expect(d.accounts.find((a) => a.id === "nick:gia")!.openingGainFraction).toBe(0.25);
    expect(d.accounts.find((a) => a.id === "tracy:savings")!.name).toBe("Tracy Savings");
    expect(d.overrides).toEqual([{ accountId: "tracy:premiumBonds", monthKey: "2026-08", day: null, value: 42, basis: null }]);
  });

  it("upgrades an untouched legacy save (all-zero pots) to the default registry", () => {
    const legacy = {
      openingMonth: "2026-07",
      pots: {
        nick: { isa: 0, pension: 0, gia: 0, savings: 0, premiumBonds: 0, gilts: 0 },
        tracy: { isa: 0, pension: 0, gia: 0, savings: 0, premiumBonds: 0, gilts: 0 },
      },
      giaGainFraction: { nick: 0, tracy: 0 },
      overrides: [],
    } as unknown as PreRetirementData;
    const d = migratePreRetirementData(legacy);
    expect(d.accounts).toHaveLength(12);
    expect(d.openingMonth).toBe("2026-07");
  });

  it("default data is a generic sample registry (person × kind) with zero balances", () => {
    const d = defaultPreRetirementData();
    expect(d.accounts).toHaveLength(12);
    expect(d.accounts.every((a) => a.openingBalance === 0)).toBe(true);
    expect(new Set(d.accounts.map((a) => a.id)).size).toBe(12); // ids unique
    expect(d.accounts.filter((a) => a.owner === "tracy" && a.kind === "pension")).toHaveLength(1);
    expect(d.accounts.some((a) => a.name === "Nick ISA")).toBe(true);
    expect(d.accounts.some((a) => a.name === "Tracy Pension")).toBe(true);
    expect(d.overrides).toEqual([]);
    expect(d.openingMonth).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("guard rails", () => {
  it("does not double-count a due day past the month's end against an end-of-month record", () => {
    // February has 28 days: a line due on the 30th lands on the 28th, inside the month-end record.
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })], "2027-02");
    d.overrides = [{ accountId: "isa1", monthKey: "2027-02", day: null, value: 10500, basis: null }];
    const months = [month("2027-02", { expense: [["isa1", 500, 0, 30]] })];
    const r = projectAccounts(d, months, RATES, "2027-02");
    expect(r.months[0].byAccount["isa1"].end).toBe(10500);
  });

  it("counts a day-31 line by the last day of a 30-day month, matching the cell end", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })], "2026-09");
    const months = [month("2026-09", { expense: [["isa1", 500, 0, 31]] })];
    const r = projectAccounts(d, months, RATES, "2026-09");
    const cellEnd = r.months[0].byAccount["isa1"].end;
    expect(balancesAtDate(r, d, months, RATES, "2026-09-30")["isa1"]).toBeCloseTo(cellEnd, 10);
  });

  it("hands off a duplicated account id once", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-08-05"; // end of 5 August: July + 5/31 of August
    const d = data([
      account({ id: "dup", kind: "isa", openingBalance: 100 }),
      account({ id: "dup", kind: "isa", openingBalance: 999, name: "copy" }),
    ]);
    const { balances, warnings } = resolveLinkedBalances(scenario, d, []);
    const r = ratesForKinds(scenario.rates).isa;
    expect(balances.nick.isa).toBeCloseTo(grow(100, r, 1 / 12) * (1 + annualToMonthly(r)) ** (5 / 31), 6);
    expect(warnings.some((w) => w.includes("Duplicate"))).toBe(true);
  });

  it("warns when withdrawals drive an account below zero, and hands off 0 for it", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-10-05"; // handoff 2026-09
    const d = data([
      account({ id: "pb", kind: "premiumBonds", openingBalance: 1000 }),
      account({ id: "isa", kind: "isa", openingBalance: 5000 }),
    ]);
    const months = ["2026-07", "2026-08", "2026-09"].map((k) => month(k, { income: [["pb", 500]] }));
    const r = projectAccounts(d, months, RATES, "2026-09");
    expect(r.warnings.some((w) => w.includes("goes below zero"))).toBe(true);
    // A negative balance doesn't "grow": the shortfall stays exactly the overdrawn amount.
    expect(r.months[2].byAccount["pb"].end).toBeLessThan(0);
    const { balances, warnings } = resolveLinkedBalances(scenario, d, months);
    expect(balances.nick.savings).toBe(0);
    expect(warnings.some((w) => w.includes("treated as 0"))).toBe(true);
  });

  it("keeps the manual balances when the registry is still all zero", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-10-05";
    const d = data([account({ id: "isa", kind: "isa" }), account({ id: "pen", kind: "pension" })]);
    const { balances, warnings } = resolveLinkedBalances(scenario, d, []);
    expect(balances).toEqual(scenario.balances);
    expect(warnings[0]).toContain("no balances have been entered");
  });

  it("treats an empty or impossible start date as having no handoff", () => {
    expect(handoffMonthKey("")).toBeNull();
    expect(handoffMonthKey("2026-02-30")).toBeNull();
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "";
    const { balances, warnings } = resolveLinkedBalances(
      scenario,
      data([account({ id: "isa", kind: "isa", openingBalance: 100 })]),
      [],
    );
    expect(balances).toEqual(scenario.balances);
    expect(warnings[0]).toContain("isn't a valid date");
  });

  it("repairs an empty start date on load", () => {
    const s = defaultScenario();
    s.startDate = "";
    expect(migrateScenario(s).startDate).toBe(`${s.income.startYear}-04-05`);
  });
});

describe("handoff on the start date itself", () => {
  it("includes flows due by the end of the start date and none after it", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2028-04-05";
    const d = data([account({ id: "isa", kind: "isa", openingBalance: 1000 })], "2028-04");
    const months = [month("2028-04", { expense: [["isa", 500, 0, 3], ["isa", 300, 0, 20]] })];
    const { balances } = resolveLinkedBalances(scenario, d, months);
    const r = ratesForKinds(scenario.rates).isa;
    // 1,000 grown for 5/30 of April, plus the 3 April contribution; the 20 April one is the engine's.
    expect(balances.nick.isa).toBeCloseTo(1000 * (1 + annualToMonthly(r)) ** (5 / 30) + 500, 6);
  });

  it("hands the GIA cost basis off as at the start date", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2028-04-10";
    const d = data([account({ id: "gia", kind: "gia", openingBalance: 10000, openingGainFraction: 0.5 })], "2028-04");
    const months = [month("2028-04", { expense: [["gia", 1000, 0, 5], ["gia", 2000, 0, 25]] })];
    const { balances } = resolveLinkedBalances(scenario, d, months);
    // Basis 5,000 + the 5 April contribution (the 25 April one comes after the handoff).
    const basis = 6000;
    expect(balances.nick.giaGainFraction).toBeCloseTo((balances.nick.gia - basis) / balances.nick.gia, 8);
  });

  it("samples the basis at a month's last day equal to the projection's month-end basis", () => {
    const d = data([account({ id: "gia", kind: "gia", openingBalance: 10000, openingGainFraction: 0.3 })]);
    const months = [
      month("2026-07", { expense: [["gia", 800, 0, 12]] }),
      month("2026-08", { expense: [["gia", 400, 0, 2]], income: [["gia", 1500]] }),
    ];
    const r = projectAccounts(d, months, RATES, "2026-08");
    const s = sampleAtDate(r, d, months, RATES, "2026-08-31");
    expect(s.basis["gia"]).toBeCloseTo(r.months[1].basis["gia"], 8);
    expect(s.balances["gia"]).toBeCloseTo(r.months[1].byAccount["gia"].end, 8);
  });
});

describe("projectAccounts — months with no expense record", () => {
  const templates = {
    expenses: [
      { id: "t-isa", name: "ISA saving", day: 10, amount: 300, accountId: "isa1" },
      { id: "t-bills", name: "Bills", day: 1, amount: 900, accountId: null },
    ],
    income: [{ id: "t-pb", name: "From bonds", amount: 50, accountId: "pb1" }],
  };
  const accounts = () => [
    account({ id: "isa1", kind: "isa" }),
    account({ id: "pb1", kind: "premiumBonds", openingBalance: 1000 }),
  ];

  it("assume the standard items' tagged lines when templates are given", () => {
    const d = data(accounts(), "2026-07");
    const r = projectAccounts(d, [month("2026-07", { expense: [["isa1", 100]] })], { ...RATES, isa: 0, premiumBonds: 0 }, "2026-09", templates);
    expect(r.missingMonthKeys).toEqual(["2026-08", "2026-09"]);
    expect(r.assumedMonths.map((m) => m.key)).toEqual(["2026-08", "2026-09"]);
    expect(r.months.map((m) => m.byAccount["isa1"].contributions)).toEqual([100, 300, 300]);
    expect(r.months[2].byAccount["pb1"].end).toBe(900);
    expect(r.warnings.some((w) => w.includes("standard items"))).toBe(true);
  });

  it("assume zero flows without templates (as before)", () => {
    const r = projectAccounts(data(accounts(), "2026-07"), [], RATES, "2026-08");
    expect(r.assumedMonths).toEqual([]);
    expect(r.months[1].byAccount["isa1"].contributions).toBe(0);
    expect(r.warnings.some((w) => w.includes("zero contributions"))).toBe(true);
  });

  it("sample mid-month in an assumed month with its contributions due by that day", () => {
    const d = data(accounts(), "2026-07");
    const rates = { ...RATES, isa: 0, premiumBonds: 0 };
    const r = projectAccounts(d, [], rates, "2026-08", templates);
    expect(sampleAtDate(r, d, [], rates, "2026-08-09").balances["isa1"]).toBe(300); // July's only
    expect(sampleAtDate(r, d, [], rates, "2026-08-10").balances["isa1"]).toBe(600);
  });
});

describe("account settings", () => {
  const flat = { ...RATES, isa: 0, pension: 0, gia: 0, gilts: 0 };

  it("grosses up pension contributions into a relief-at-source account by 25%", () => {
    const d = data([
      account({ id: "ras", kind: "pension", reliefAtSource: true }),
      account({ id: "netpay", kind: "pension" }),
    ]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["ras", 800], ["netpay", 800]] })], flat, "2026-07");
    expect(r.months[0].byAccount["ras"].contributions).toBe(1000);
    expect(r.months[0].byAccount["netpay"].contributions).toBe(800);
  });

  it("adds outside contributions on the last day of every month", () => {
    const d = data([account({ id: "p", kind: "pension", externalMonthlyContribution: 500 })]);
    const r = projectAccounts(d, [], flat, "2026-09");
    expect(r.months.map((m) => m.byAccount["p"].contributions)).toEqual([500, 500, 500]);
    // Not there yet mid-month; there at the end of the last day.
    expect(sampleAtDate(r, d, [], flat, "2026-08-30").balances["p"]).toBe(500);
    expect(sampleAtDate(r, d, [], flat, "2026-08-31").balances["p"]).toBe(1000);
    // A mid-month record contains none of it; the month-end payment still lands after it.
    d.overrides = [{ accountId: "p", monthKey: "2026-08", day: 15, value: 2000, basis: null }];
    expect(projectAccounts(d, [], flat, "2026-08").months[1].byAccount["p"].end).toBe(2500);
  });

  it("adds outside GIA contributions to the cost basis", () => {
    const d = data([
      account({ id: "g", kind: "gia", openingBalance: 1000, openingGainFraction: 0.5, externalMonthlyContribution: 100 }),
    ]);
    const r = projectAccounts(d, [], flat, "2026-08");
    expect(r.months[1].basis["g"]).toBe(500 + 200);
  });

  it("re-anchors the GIA basis at a recorded basis, keeping later contributions", () => {
    const d = data([account({ id: "g", kind: "gia", openingBalance: 1000, openingGainFraction: 0 })]);
    d.overrides = [{ accountId: "g", monthKey: "2026-08", day: 10, value: 1500, basis: 1800 }];
    const months = [month("2026-08", { expense: [["g", 200, 0, 20]] }), month("2026-09", { expense: [["g", 50, 0, 5]] })];
    const r = projectAccounts(d, months, flat, "2026-09");
    expect(r.months[1].basis["g"]).toBe(1800 + 200); // the contribution due after the record
    expect(r.months[2].basis["g"]).toBe(2050);
    expect(sampleAtDate(r, d, months, flat, "2026-08-12").basis["g"]).toBe(1800);
    expect(sampleAtDate(r, d, months, flat, "2026-08-31").basis["g"]).toBe(2000);
  });

  it("takes basis out of a recorded month's withdrawal in proportion to the recorded value", () => {
    const d = data([account({ id: "g", kind: "gia", openingBalance: 1000, openingGainFraction: 0 })]);
    // Recorded at 2,000 after selling 1,000 at the start of the month: a third of the holding sold.
    d.overrides = [{ accountId: "g", monthKey: "2026-07", day: null, value: 2000, basis: null }];
    const r = projectAccounts(d, [month("2026-07", { income: [["g", 1000]] })], flat, "2026-07");
    expect(r.months[0].basis["g"]).toBeCloseTo(1000 - 1000 * (1000 / 3000), 9);
  });

  it("hands over a negative gain fraction when the basis exceeds the value (an unrealised loss)", () => {
    const s = defaultScenario();
    s.linkPreRetirement = true;
    s.startDate = "2026-08-31";
    const d = data([account({ id: "g", kind: "gia", openingBalance: 10_000, openingGainFraction: 0 })], "2026-07");
    d.overrides = [{ accountId: "g", monthKey: "2026-08", day: null, value: 8_000, basis: null }];
    const { balances } = resolveLinkedBalances(s, d, []);
    expect(balances.nick.gia).toBe(8_000);
    expect(balances.nick.giaGainFraction).toBeCloseTo(-0.25, 9);
  });

  it("warns when a gilt holding matures by the end of the projection", () => {
    const d = data([
      account({ id: "early", kind: "gilts", maturityYear: 2027, name: "Short gilt" }),
      account({ id: "late", kind: "gilts", maturityYear: 2035, name: "Long gilt" }),
    ]);
    const w = projectAccounts(d, [], flat, "2028-03").warnings;
    expect(w.filter((x) => x.includes("matures"))).toHaveLength(1);
    expect(w.some((x) => x.startsWith("Short gilt matures in 2027"))).toBe(true);
  });
});

describe("allowance checks", () => {
  const flat = { ...RATES, isa: 0, pension: 0, premiumBonds: 0 };
  const scenario = () => {
    const s = defaultScenario();
    s.people.nick.name = "Alex";
    return s;
  };

  it("place a contribution in the UK tax year of its due day", () => {
    expect(taxYearOfDay("2027-04", 5)).toBe(2026);
    expect(taxYearOfDay("2027-04", 6)).toBe(2027);
    expect(taxYearOfDay("2027-04", null)).toBe(2026); // undated = the 1st
    expect(taxYearOfDay("2027-03", 31)).toBe(2026);
  });

  it("flag ISA contributions above the year's allowance, per person and tax year", () => {
    const d = data([account({ id: "i1", kind: "isa" }), account({ id: "i2", kind: "isa" })], "2027-04");
    // 2 × 1,000 a month due on the 6th from April = 24,000 in 2027/28.
    const months = monthKeysBetween("2027-04", "2028-03").map((k) =>
      month(k, { expense: [["i1", 1000, 0, 6], ["i2", 1000, 0, 6]] }),
    );
    const r = projectAccounts(d, months, flat, "2028-03");
    const w = allowanceWarnings(r, months, scenario());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Alex: £24,000 goes into ISAs in tax year 2027/28");
  });

  it("count relief and outside contributions against the pension annual allowance", () => {
    const d = data(
      [account({ id: "p", kind: "pension", reliefAtSource: true, externalMonthlyContribution: 2000 })],
      "2027-04",
    );
    const months = monthKeysBetween("2027-04", "2028-03").map((k) => month(k, { expense: [["p", 2400, 0, 10]] }));
    // 12 × (2,400 × 1.25 + 2,000) = 60,000: exactly at the allowance — no warning.
    expect(allowanceWarnings(projectAccounts(d, months, flat, "2028-03"), months, scenario())).toEqual([]);
    months[5].expenses[0].amount = 2480;
    const w = allowanceWarnings(projectAccounts(d, months, flat, "2028-03"), months, scenario());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("£60,100 gross goes into pensions in tax year 2027/28");
  });

  it("flag a Premium Bond holding above the £50,000 limit", () => {
    const d = data([account({ id: "pb", kind: "premiumBonds", openingBalance: 49_000 })], "2026-07");
    const months = [month("2026-08", { expense: [["pb", 2000]] })];
    const w = allowanceWarnings(projectAccounts(d, months, flat, "2026-09"), months, scenario());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Alex's Premium Bonds reach £51,000");
    expect(w[0]).toContain("August 2026");
  });
});

describe("Premium Bonds at the holding limit", () => {
  it("stop growing at £50,000 (prizes above it are paid out) and raise no warning", () => {
    const d = data([account({ id: "pb", kind: "premiumBonds", openingBalance: 49_000 })], "2026-07");
    const r = projectAccounts(d, [], RATES, "2027-06");
    expect(r.months[0].byAccount["pb"].end).toBeCloseTo(49_000 + 49_000 * annualToMonthly(0.045), 9);
    expect(r.months[11].byAccount["pb"].end).toBe(50_000);
    expect(sampleAtDate(r, d, [], RATES, "2027-03-15").balances["pb"]).toBe(50_000);
    expect(allowanceWarnings(r, [], defaultScenario())).toEqual([]);
  });

  it("don't grow past the limit after a recorded balance at it", () => {
    const d = data([account({ id: "pb", kind: "premiumBonds", openingBalance: 40_000 })], "2026-07");
    d.overrides = [{ accountId: "pb", monthKey: "2026-08", day: 10, value: 50_000, basis: null }];
    const r = projectAccounts(d, [], RATES, "2026-09");
    expect(r.months[1].byAccount["pb"].end).toBe(50_000);
    expect(r.months[2].byAccount["pb"].end).toBe(50_000);
  });
});

describe("Premium Bonds topped up to the limit", () => {
  it("earn no prize growth on top once a deposit fills the holding", () => {
    const d = data([account({ id: "pb", kind: "premiumBonds", openingBalance: 44_000 })], "2026-07");
    const months = [month("2026-07", { expense: [["pb", 6_000, 0, 15]] })];
    const r = projectAccounts(d, months, RATES, "2026-08");
    expect(r.months[0].byAccount["pb"].end).toBe(50_000);
    expect(r.months[1].byAccount["pb"].end).toBe(50_000);
    expect(sampleAtDate(r, d, months, RATES, "2026-07-31").balances["pb"]).toBe(50_000);
    expect(allowanceWarnings(r, months, defaultScenario())).toEqual([]);
  });
});
