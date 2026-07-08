import type { Scenario } from "./types";

/**
 * Default scenario — illustrative sample data only.
 * Replace these figures with your own; scenarios are saved to your local
 * SQL Server database (with a browser-storage fallback while it is offline).
 */
export function defaultScenario(): Scenario {
  return {
    id: "default",
    name: "Sample couple — base case",
    startDate: "2028-04-05",
    linkPreRetirement: false,
    people: {
      nick: {
        id: "nick",
        name: "Person A",
        dob: "1975-03-15",
        pensionAccessAge: 57, // NMPA rises to 57 on 6 Apr 2028 -> accesses 2032
        statePensionAge: 67,
        statePensionAnnual: 11500,
      },
      tracy: {
        id: "tracy",
        name: "Person B",
        dob: "1970-05-15",
        pensionAccessAge: 55, // already 57+ at the start regardless
        statePensionAge: 67,
        statePensionAnnual: 11500,
      },
    },
    balances: {
      nick: { isa: 200000, pension: 1000000, gia: 90000, savings: 50000, gilts: 15000, giaGainFraction: 0.3 },
      tracy: { isa: 180000, pension: 750000, gia: 90000, savings: 75000, gilts: 0, giaGainFraction: 0.3 },
    },
    rates: {
      investmentGrowth: 0.07,
      savingsInterest: 0.035,
      inflation: 0.03,
      giltCoupon: 0.04,
      giaDividendYield: 0.02,
    },
    income: {
      mode: "fixed",
      baseAnnual: 80000,
      swrRate: 0.035,
      startYear: 2028,
      years: 48,
      growth: 0.03,
    },
    strategy: {
      bufferYears: 3,
      autoStrategy: true,
      fillPersonalAllowanceFromPension: true,
      preserveIsa: true,
      giltLadderYears: 3,
      taxMode: "heuristic",
    },
    finalIncome: {
      date: "2028-04-06",
      perPerson: {
        nick: { net: 78000, tax: 22000 },
        tracy: { net: 78000, tax: 22000 },
      },
    },
    taxParams: [],
    overrides: [],
    purchases: [],
  };
}
