import { describe, expect, it } from "vitest";
import type { ExpenseMonth } from "../model/expenseTypes";
import type { InvestmentAccount, PreRetirementData } from "../model/preRetirementTypes";
import { defaultPreRetirementData } from "../model/preRetirementTypes";
import { annualToMonthly, grow } from "../model/rates";
import { defaultScenario } from "../model/defaults";
import { migratePreRetirementData } from "../model/migrate";
import {
  balancesAtDate,
  latestOverride,
  projectAccounts,
  ratesForKinds,
  type KindRates,
} from "../preretirement/project";
import {
  handoffMonthKey,
  resolveLinkedBalances,
  resolveScenarioForRun,
} from "../preretirement/link";

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
    ...partial,
  };
}

function data(accounts: InvestmentAccount[], openingMonth = "2026-07"): PreRetirementData {
  return { openingMonth, accounts, overrides: [] };
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

  it("maps scenario rates onto kinds (inv/inv/inv/sav/sav/coupon)", () => {
    const k = ratesForKinds(defaultScenario().rates);
    expect(k.isa).toBe(0.07);
    expect(k.pension).toBe(0.07);
    expect(k.gia).toBe(0.07);
    expect(k.savings).toBe(0.035);
    expect(k.premiumBonds).toBe(0.035);
    expect(k.gilts).toBe(0.04);
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
      account({ id: "vanguard-pension", kind: "pension", openingBalance: 1000 }),
      account({ id: "mcl-pension", kind: "pension", openingBalance: 2000 }),
    ]);
    const r = projectAccounts(d, [month("2026-07", { expense: [["mcl-pension", 300]] })], RATES, "2026-07");
    expect(r.months[0].byAccount["vanguard-pension"].contributions).toBe(0);
    expect(r.months[0].byAccount["mcl-pension"].contributions).toBe(300);
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
    d.overrides = [{ accountId: "isa1", monthKey: "2026-08", day: null, value: 9000 }];
    const r = projectAccounts(d, [], RATES, "2026-09");
    expect(r.months[1].byAccount["isa1"].end).toBe(9000);
    expect(r.months[1].byAccount["isa1"].recorded).toEqual({ day: null, value: 9000 });
    const sep = r.months[2].byAccount["isa1"];
    expect(sep.start).toBe(9000);
    expect(sep.end).toBeCloseTo(9000 * (1 + annualToMonthly(0.07)), 10);
    expect(sep.recorded).toBeNull();
  });

  it("re-anchors mid-month and pro-rates the rest of the month's growth by calendar days", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 10000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-08", day: 10, value: 9000 }];
    const r = projectAccounts(d, [], RATES, "2026-09");
    const aug = r.months[1].byAccount["isa1"];
    const expectedEnd = 9000 * Math.pow(1 + annualToMonthly(0.07), (31 - 10) / 31);
    expect(aug.recorded).toEqual({ day: 10, value: 9000 });
    expect(aug.growth).toBeCloseTo(expectedEnd - 9000, 10);
    expect(aug.end).toBeCloseTo(expectedEnd, 10);
    expect(r.months[2].byAccount["isa1"].start).toBeCloseTo(expectedEnd, 10);
  });

  it("still adds contributions due after the recorded day; earlier and undated ones are inside the balance", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    d.overrides = [{ accountId: "isa1", monthKey: "2026-07", day: 10, value: 2000 }];
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
    d.overrides = [{ accountId: "pb1", monthKey: "2026-07", day: 10, value: 5000 }];
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
      { accountId: "a31", monthKey: "2026-09", day: 31, value: 900 }, // September has 30 days
      { accountId: "aNull", monthKey: "2026-09", day: null, value: 900 },
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
      { accountId: "isa1", monthKey: "2026-08", day: 20, value: 9500 },
      { accountId: "isa1", monthKey: "2026-08", day: 10, value: 9000 },
    ];
    const r = projectAccounts(d, [], RATES, "2026-08");
    const aug = r.months[1].byAccount["isa1"];
    expect(aug.recorded).toEqual({ day: 20, value: 9500 });
    expect(aug.end).toBeCloseTo(9500 * Math.pow(1 + annualToMonthly(0.07), (31 - 20) / 31), 10);

    d.overrides.push({ accountId: "isa1", monthKey: "2026-08", day: null, value: 9800 });
    const r2 = projectAccounts(d, [], RATES, "2026-08");
    expect(r2.months[1].byAccount["isa1"].end).toBe(9800);
  });

  it("ignores overrides before the opening month or for unknown accounts, with warnings", () => {
    const d = data([account({ id: "isa1", kind: "isa", openingBalance: 1000 })]);
    d.overrides = [
      { accountId: "isa1", monthKey: "2026-01", day: null, value: 5 },
      { accountId: "ghost", monthKey: "2026-07", day: null, value: 5 },
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
      { accountId: "isa1", monthKey: "2026-08", day: 20, value: 2 },
      { accountId: "other", monthKey: "2026-12", day: 1, value: 99 },
      { accountId: "isa1", monthKey: "2026-08", day: null, value: 3 },
      { accountId: "isa1", monthKey: "2026-07", day: 8, value: 1 },
    ];
    expect(latestOverride(d, "isa1")?.value).toBe(3); // end of August beats 20 August
    d.overrides.push({ accountId: "isa1", monthKey: "2026-08", day: null, value: 4 });
    expect(latestOverride(d, "isa1")?.value).toBe(4); // later entry wins the tie
    expect(latestOverride(d, "ghost")).toBeNull();
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
      { accountId: "isa1", monthKey: "2026-07", day: 8, value: 9000 },
      { accountId: "isa1", monthKey: "2026-07", day: 20, value: 9500 },
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
    d.overrides = [{ accountId: "isa1", monthKey: "2026-07", day: null, value: 9000 }];
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
  it("hands off the month before the startDate month", () => {
    expect(handoffMonthKey("2033-04-05")).toBe("2033-03");
    expect(handoffMonthKey("2028-01-01")).toBe("2027-12");
  });

  it("aggregates accounts by owner and kind: pensions sum, savings + premium bonds merge, gilts flow", () => {
    const scenario = defaultScenario();
    scenario.linkPreRetirement = true;
    scenario.startDate = "2026-10-05"; // handoff month 2026-09
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
    expect(balances.nick.isa).toBeCloseTo(grow(100, kinds.isa, 3 / 12), 6);
    expect(balances.nick.pension).toBeCloseTo(grow(200 + 300, kinds.pension, 3 / 12), 6);
    expect(balances.nick.savings).toBeCloseTo(
      grow(400, kinds.savings, 3 / 12) + grow(50, kinds.premiumBonds, 3 / 12),
      6,
    );
    expect(balances.nick.gilts).toBeCloseTo(grow(600, kinds.gilts, 3 / 12), 6);
    // Basis stays 7000 while the value grows, so the gain fraction rises.
    const gia = grow(10000, kinds.gia, 3 / 12);
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
    expect(out.balances.tracy.savings).toBeCloseTo(grow(1000, 0.035, 2 / 12), 6);
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
    expect(d.overrides).toEqual([{ accountId: "a", monthKey: "2026-08", day: null, value: 42 }]);
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
    expect(d.overrides).toEqual([{ accountId: "tracy:premiumBonds", monthKey: "2026-08", day: null, value: 42 }]);
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
    expect(d.accounts).toHaveLength(16);
    expect(d.openingMonth).toBe("2026-07");
  });

  it("default data is the real 16-account registry with zero balances", () => {
    const d = defaultPreRetirementData();
    expect(d.accounts).toHaveLength(16);
    expect(d.accounts.every((a) => a.openingBalance === 0)).toBe(true);
    expect(new Set(d.accounts.map((a) => a.id)).size).toBe(16); // ids unique
    expect(d.accounts.filter((a) => a.owner === "tracy" && a.kind === "pension")).toHaveLength(4);
    expect(d.accounts.some((a) => a.name === "Nick Vanguard ISA")).toBe(true);
    expect(d.accounts.some((a) => a.name === "Tracy Royal London")).toBe(true);
    expect(d.overrides).toEqual([]);
    expect(d.openingMonth).toMatch(/^\d{4}-\d{2}$/);
  });
});
