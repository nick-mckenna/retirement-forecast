import { describe, expect, it } from "vitest";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { migrateScenario } from "../model/migrate";
import type { Scenario } from "../model/types";
import { LUMP_SUM_ALLOWANCE, lsaUsedBy, pensionGrossForTaxable, pensionTaxable } from "../tax/pensionDraw";
import { coupleYearTax, marriageAllowance, personYearTax } from "../tax/personTax";
import {
  statePensionForYear,
  statePensionGrowth,
  statePensionStartDate,
  statutoryStatePensionAge,
  statutoryStatePensionDate,
} from "../tax/statePension";
import { DEFAULT_TAX_POLICY, projectTaxParams } from "../tax/taxParams";
import { toIso } from "../tax/taxYear";

// Synthetic figures only.

describe("Lump Sum Allowance", () => {
  it("makes 25% tax-free only while the allowance lasts", () => {
    expect(pensionTaxable(100_000, LUMP_SUM_ALLOWANCE)).toBe(75_000);
    expect(pensionTaxable(100_000, 10_000)).toBe(90_000); // only £10k of tax-free cash left
    expect(pensionTaxable(100_000, 0)).toBe(100_000);
    expect(lsaUsedBy(100_000, 10_000)).toBe(10_000);
  });

  it("inverts exactly: the gross that yields a given taxable amount", () => {
    for (const lsa of [0, 5_000, 30_000, LUMP_SUM_ALLOWANCE]) {
      for (const taxable of [1_000, 20_000, 90_000]) {
        expect(pensionTaxable(pensionGrossForTaxable(taxable, lsa), lsa)).toBeCloseTo(taxable, 6);
      }
    }
  });

  it.each(["heuristic", "annual", "lifetime"] as const)("never lets a person take more than the allowance tax-free over the plan (%s)", (mode) => {
    const s = defaultScenario();
    s.strategy.taxMode = mode;
    if (mode === "lifetime") s.strategy.lifetimeFillFraction = 0.75;
    const r = simulate(s);
    for (const id of ["nick", "tracy"] as const) {
      const taxFree = r.years
        .flatMap((y) => y.withdrawals)
        .filter((w) => w.person === id && w.source === "pension")
        .reduce((t, w) => t + w.lsaUsed, 0);
      expect(taxFree).toBeLessThanOrEqual(LUMP_SUM_ALLOWANCE + 0.01);
      // Everyone here draws well over 4 × the allowance, so it is used in full.
      expect(taxFree).toBeCloseTo(LUMP_SUM_ALLOWANCE, 0);
    }
  });

  it("taxes every pound drawn once the allowance is used up before the model starts", () => {
    const s = defaultScenario();
    s.people.tracy.lumpSumAllowanceUsed = LUMP_SUM_ALLOWANCE;
    const draws = simulate(s)
      .years.flatMap((y) => y.withdrawals)
      .filter((w) => w.person === "tracy" && w.source === "pension");
    expect(draws.length).toBeGreaterThan(0);
    for (const w of draws) expect(w.taxableNonSavings).toBeCloseTo(w.gross, 6);
  });
});

describe("State Pension age (legislated timetable)", () => {
  const spa = (dob: string) => toIso(statutoryStatePensionDate(dob));
  it("is 66 before the 1960 cohort and 67 from 6 March 1961", () => {
    expect(spa("1955-01-01")).toBe("2021-01-01");
    expect(spa("1961-03-10")).toBe("2028-03-10");
    expect(spa("1977-04-05")).toBe("2044-04-05");
  });

  it("adds 1–11 months for those born 6 April 1960 – 5 March 1961", () => {
    expect(spa("1960-04-10")).toBe("2026-05-10"); // 66y 1m
    expect(spa("1960-09-20")).toBe("2027-03-20"); // 66y 6m
    expect(spa("1961-02-10")).toBe("2028-01-10"); // 66y 11m
    expect(spa("1960-07-31")).toBe("2026-11-30"); // 66y 4m — falls on the month's last day
    expect(statutoryStatePensionAge("1960-09-20")).toBeCloseTo(66.5, 10);
  });

  it("uses the fixed 2044–46 dates for those born 6 April 1977 – 5 April 1978, then 68", () => {
    expect(spa("1977-04-20")).toBe("2044-05-06");
    expect(spa("1977-05-10")).toBe("2044-07-06");
    expect(spa("1978-03-20")).toBe("2046-03-06");
    expect(spa("1978-04-06")).toBe("2046-04-06"); // 68th birthday
  });

  it("honours a fractional override (66.25 = 66 years 3 months)", () => {
    const p = { ...defaultScenario().people.nick, dob: "1970-01-15", statePensionAge: 66.25 };
    expect(toIso(statePensionStartDate(p))).toBe("2036-04-15");
  });
});

describe("State Pension amounts", () => {
  it("uprates by the triple-lock floor unless a growth rate is set", () => {
    const r = defaultScenario().rates;
    expect(statePensionGrowth({ ...r, inflation: 0.01, statePensionGrowth: null })).toBe(0.025);
    expect(statePensionGrowth({ ...r, inflation: 0.04, statePensionGrowth: null })).toBe(0.04);
    expect(statePensionGrowth({ ...r, inflation: 0.04, statePensionGrowth: 0.02 })).toBe(0.02);
  });

  it("is paid only from the State Pension start date, matching the annual figure", () => {
    const s = defaultScenario();
    const person = s.people.tracy; // statutory 67 → 15 May 2037
    const r = simulate(s);
    const credited = r.rows
      .filter((x) => x.label === "State Pension" && x.dateIso >= "2037-04-06" && x.dateIso < "2038-04-06")
      .reduce((t, x) => t + x.tracy.income, 0);
    expect(r.rows.some((x) => x.label === "State Pension" && x.dateIso < "2037-04-06" && x.tracy.income > 0)).toBe(false);
    expect(credited).toBeCloseTo(statePensionForYear(person, 2037, 2028, statePensionGrowth(s.rates)), 6);
  });
});

describe("marriage allowance", () => {
  const p = projectTaxParams(2025, DEFAULT_TAX_POLICY, 0);
  const inc = (nonSavings: number) => ({ nonSavings, savings: 0, dividends: 0, gain: 0 });

  it("is 10% of the personal allowance rounded up to £10, worth £252 to a basic-rate partner", () => {
    expect(marriageAllowance(p)).toBe(1260);
    const single = personYearTax(inc(30_000), p).total;
    const both = coupleYearTax(inc(5_000), inc(30_000), p, true);
    expect(both.b.total).toBeCloseTo(single - 252, 2);
    expect(both.a.total).toBe(0); // the transferor still pays nothing on £5,000
  });

  it("is not applied when not married, when a partner pays higher rate, or when it wouldn't help", () => {
    expect(coupleYearTax(inc(5_000), inc(30_000), p, false).b.total).toBeCloseTo(personYearTax(inc(30_000), p).total, 2);
    const higher = coupleYearTax(inc(5_000), inc(60_000), p, true);
    expect(higher.b.total).toBeCloseTo(personYearTax(inc(60_000), p).total, 2);
    const bothUseFullAllowance = coupleYearTax(inc(30_000), inc(30_000), p, true);
    expect(bothUseFullAllowance.a.total + bothUseFullAllowance.b.total).toBeCloseTo(
      2 * personYearTax(inc(30_000), p).total,
      2,
    );
  });
});

describe("scenario migration v2 → v3", () => {
  function v2(people: Partial<Record<"nick" | "tracy", object>>): Scenario {
    const s = defaultScenario() as unknown as Record<string, any>;
    s.schemaVersion = 2;
    delete s.married;
    delete s.rates.statePensionGrowth;
    for (const id of ["nick", "tracy"]) {
      delete s.people[id].lumpSumAllowanceUsed;
      s.people[id] = { ...s.people[id], statePensionAge: 67, ...(people as any)[id] };
    }
    return s as unknown as Scenario;
  }

  it("turns a stored whole-year age that is just the statutory age into 'statutory'", () => {
    const m = migrateScenario(v2({ tracy: { dob: "1960-09-20", statePensionAge: 66 } }));
    expect(m.people.nick.statePensionAge).toBeNull(); // 1975: statutory 67
    expect(m.people.tracy.statePensionAge).toBeNull(); // statutory 66y 6m, stored as 66
  });

  it("keeps a genuine override", () => {
    expect(migrateScenario(v2({ nick: { statePensionAge: 68 } })).people.nick.statePensionAge).toBe(68);
  });

  it("backfills the new fields", () => {
    const m = migrateScenario(v2({}));
    expect(m.people.nick.lumpSumAllowanceUsed).toBe(0);
    expect(m.rates.statePensionGrowth).toBeNull();
    expect(m.married).toBe(false);
  });
});
