import { describe, expect, it } from "vitest";
import type { LedgerRow, PersonColumns } from "../engine/ledger";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { migrateScenario } from "../model/migrate";
import type { Scenario, StrategyConfig } from "../model/types";
import { makePlan } from "../strategy/drawdown";
import { DEFAULT_TAX_POLICY, projectTaxParams } from "../tax/taxParams";

// Synthetic scenarios only.

const POTS: (keyof PersonColumns)[] = ["isa", "pension", "gia", "savings", "giltsTotal"];

/** Every BALANCE row must equal the previous one plus the TRANSACTION deltas in between,
 *  for every pot and person — so each movement is booked to the pot (and person) it moved. */
function expectLedgerReconciles(rows: LedgerRow[]) {
  let prev: LedgerRow | null = null;
  let acc = { nick: {} as Record<string, number>, tracy: {} as Record<string, number> };
  for (const r of rows) {
    if (r.type === "TRANSACTION") {
      for (const id of ["nick", "tracy"] as const) {
        for (const c of POTS) acc[id][c] = (acc[id][c] ?? 0) + r[id][c];
      }
      continue;
    }
    if (prev) {
      for (const id of ["nick", "tracy"] as const) {
        for (const c of POTS) {
          expect(prev[id][c] + (acc[id][c] ?? 0), `${r.label} ${r.dateIso} ${id}.${c}`).toBeCloseTo(r[id][c], 4);
        }
      }
    }
    prev = r;
    acc = { nick: {}, tracy: {} };
  }
}

const MODES: StrategyConfig["taxMode"][] = ["heuristic", "annual", "lifetime"];

/** No investments to sell: income must come from cash, then gilts. */
function giltsOnly(): Scenario {
  const s = defaultScenario();
  for (const id of ["nick", "tracy"] as const) {
    s.balances[id] = { ...s.balances[id], isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0 };
    s.finalIncome.perPerson[id] = { net: 0, tax: 0 };
  }
  s.balances.nick.gilts = 200_000;
  return s;
}

describe.each(MODES)("ledger reconciliation (%s)", (mode) => {
  it("reconciles on the sample scenario", () => {
    const s = defaultScenario();
    s.strategy.taxMode = mode;
    if (mode === "lifetime") s.strategy.lifetimeFillFraction = 0.75;
    s.purchases = [{ id: "p1", label: "Car", date: "2031-06-01", amount: 40_000 }];
    expectLedgerReconciles(simulate(s).rows);
  });

  it("reconciles when income is drawn from gilts and from the spouse's cash", () => {
    const s = giltsOnly();
    s.strategy.taxMode = mode;
    expectLedgerReconciles(simulate(s).rows);
  });
});

describe("GIA gains come from the tracked cost basis", () => {
  /** A GIA with no embedded gain at the start and no ISA room, so it is sold over time. */
  function giaHeavy(yieldRate: number): Scenario {
    const s = defaultScenario();
    s.rates.giaDividendYield = yieldRate;
    for (const id of ["nick", "tracy"] as const) {
      s.balances[id] = { ...s.balances[id], isa: 0, pension: 0, gia: 600_000, giaGainFraction: 0 };
    }
    s.taxParams = Array.from({ length: s.income.years }, (_, i) => ({ year: s.income.startYear + i, isaAllowance: 0 }));
    return s;
  }
  const gains = (s: Scenario) => simulate(s).years.reduce((t, y) => t + y.tax.nick.realisedGain, 0);

  it("realises gains as the holding grows, even from a zero starting gain fraction", () => {
    expect(gains(giaHeavy(0))).toBeGreaterThan(10_000);
  });

  it("adds reinvested dividends to the basis, so they are not taxed again as gains", () => {
    expect(gains(giaHeavy(0.03))).toBeLessThan(gains(giaHeavy(0)));
  });
});

describe("sale plans", () => {
  it("leave only what the year's earlier gains haven't used of the CGT exempt amount", () => {
    const p = projectTaxParams(2028, DEFAULT_TAX_POLICY, 0.025);
    expect(makePlan("nick", true, 0, 0.5, p, 0, 0).cgtAllowanceRemaining).toBe(3000);
    expect(makePlan("nick", true, 0, 0.5, p, 0, 1200).cgtAllowanceRemaining).toBe(1800);
    expect(makePlan("nick", true, 0, 0.5, p, 0, 6000).cgtAllowanceRemaining).toBe(0);
  });

  it("judge pension access on the sale date: a birthday during the year counts at the year-end refill", () => {
    const s = defaultScenario();
    s.people.nick.dob = "1971-09-01"; // 56 on 6 April 2028, 57 by the 5 April 2029 refill
    s.people.nick.pensionAccessAge = 57;
    s.balances.nick.pension = 500_000;
    s.finalIncome.perPerson.nick = { net: 0, tax: 0 }; // leave his personal allowance free that year
    expect(simulate(s).years[0].disposals.sales.nick.pension).toBeGreaterThan(0);
  });
});

describe("final employment income is earnings of its tax year", () => {
  /** £60,000 gross salary with exact 2028/29 PAYE (taxable 47,430: 7,540 + 3,892 = 11,432),
   *  and nothing else taxable for Person A that year. */
  function salaryOnly(): Scenario {
    const s = defaultScenario();
    s.rates.savingsInterest = 0;
    s.rates.giaDividendYield = 0;
    s.rates.giltCoupon = 0; // no coupon income either
    s.people.nick.pensionAccessAge = 99;
    s.balances.nick = { ...s.balances.nick, gia: 0, pension: 0, isa: 2_000_000 };
    s.finalIncome.perPerson.nick = { net: 60_000 - 11_432, tax: 11_432 };
    return s;
  }

  it("counts the gross towards the year's income and credits the PAYE already paid", () => {
    const y0 = simulate(salaryOnly()).years[0].tax.nick;
    expect(y0.taxableNonSavings).toBeGreaterThanOrEqual(60_000);
    expect(y0.paidAtSource).toBe(11_432);
    expect(y0.total).toBeCloseTo(11_432, 0);
    expect(y0.due).toBeCloseTo(0, 0); // exact PAYE: nothing more to pay at year end
  });

  it("taxes pension drawn in the same year on top of the salary", () => {
    const s = salaryOnly();
    s.people.nick.pensionAccessAge = 50; // accessible in year 1 (default Person A is ~53)
    s.balances.nick = { ...s.balances.nick, isa: 0, pension: 2_000_000 };
    // Nothing for Person B to sell, so the refill has to come from A's pension.
    s.balances.tracy = { ...s.balances.tracy, isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0 };
    s.finalIncome.perPerson.tracy = { net: 0, tax: 0 };
    const y0 = simulate(s).years[0];
    const sold = y0.disposals.sales.nick.pension;
    expect(sold).toBeGreaterThan(0);
    // The salary and the drawdown are one year's income, taxed together…
    expect(y0.tax.nick.taxableNonSavings).toBeCloseTo(60_000 + sold * 0.75, 0);
    // …PAYE is credited against the bill…
    expect(y0.tax.nick.due).toBeCloseTo(y0.tax.nick.total - 11_432, 1);
    // …and with the basic band already used by the salary, every £ of it is taxed at 40%+.
    expect(y0.tax.nick.due).toBeGreaterThan(sold * 0.75 * 0.4);
  });

  it("warns when the final income date falls after the modelled period", () => {
    const s = defaultScenario();
    s.finalIncome.date = "2099-01-01";
    expect(simulate(s).warnings.some((w) => w.includes("final income on 2099-01-01"))).toBe(true);
  });
});

describe("income is drawn from gilts when cash runs out", () => {
  it("sells gilts at par instead of leaving the income unpaid", () => {
    const r = simulate(giltsOnly());
    expect(r.years[0].disposals.giltSales.nick).toBeGreaterThan(50_000);
    expect(r.warnings.some((w) => w.includes("2028/29 ("))).toBe(false); // no shortfall in year 1
  });
});

describe("the model starts the day after the start date", () => {
  it("models only the months after a mid-year start (a part first year)", () => {
    const s = defaultScenario();
    s.startDate = "2028-10-01";
    const r = simulate(s);
    expect(r.years[0].taxYearStart).toBe(2028);
    const firstYearIncome = r.rows.filter((x) => x.label === "Income" && x.dateIso < "2029-04-06");
    expect(firstYearIncome[0].dateIso).toBe("2028-10-06");
    expect(firstYearIncome).toHaveLength(6);
  });

  it("derives the income start year from the start date, warning about a stale stored one", () => {
    const s = defaultScenario();
    s.income.startYear = 2030; // inconsistent with startDate 2028-04-05
    const r = simulate(s);
    expect(r.years[0].taxYearStart).toBe(2028);
    expect(r.warnings.some((w) => w.includes("didn't match the start date"))).toBe(true);
  });
});

describe("user overrides are fixed refill sales", () => {
  it("sells exactly the overridden amount and raises the rest automatically, landing on target", () => {
    const s = defaultScenario();
    s.overrides = [{ key: "2029:tracy:pension", amount: 30_000 }];
    const r = simulate(s);
    const y = r.years.find((x) => x.taxYearStart === 2029)!;
    expect(y.disposals.sales.tracy.pension).toBeCloseTo(30_000, 6);
    expect(y.bufferEnd).toBeCloseTo(y.bufferTargetValue, 0); // the tax provision saw the override
  });

  it("clamps an override to what the pot holds, with a warning", () => {
    const s = defaultScenario();
    s.overrides = [{ key: "2029:tracy:isa", amount: 99_000_000 }];
    const r = simulate(s);
    expect(r.warnings.some((w) => w.includes('Override "2029:tracy:isa" asks for'))).toBe(true);
    expectLedgerReconciles(r.rows);
    for (const row of r.rows.filter((x) => x.type === "BALANCE")) expect(row.tracy.isa).toBeGreaterThanOrEqual(-0.01);
  });

  it("warns about malformed and out-of-range keys instead of silently ignoring them", () => {
    const s = defaultScenario();
    s.overrides = [
      { key: "2030:refill:nick:pension", amount: 1000 },
      { key: "2099:nick:isa", amount: 1000 },
    ];
    const w = simulate(s).warnings;
    expect(w.some((x) => x.includes('"2030:refill:nick:pension" isn\'t a valid'))).toBe(true);
    expect(w.some((x) => x.includes('"2099:nick:isa" is for a year outside'))).toBe(true);
  });

  it("migrates the old documented key forms to the one that matches", () => {
    const s = defaultScenario();
    s.overrides = [
      { key: "2030:refill:nick:pension", amount: 1000 },
      { key: "2030:refill:nick:pension:30", amount: 500 },
      { key: "2031:tracy:gia", amount: 200 },
    ];
    expect(migrateScenario(s).overrides).toEqual([
      { key: "2030:nick:pension", amount: 1500 },
      { key: "2031:tracy:gia", amount: 200 },
    ]);
  });
});
