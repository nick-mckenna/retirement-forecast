// Pure mapping between the Scenario domain object and the normalized SQL rows.
// No DB or Node dependencies so it can be unit-tested alongside the engine.
//
// Every user-editable Scenario field must appear here exactly once in each
// direction; the round-trip test in src/__tests__/sqlMapping.test.ts guards that.

import type {
  OneOffPurchase,
  Override,
  PersonId,
  Scenario,
  TaxPolicy,
  TaxYearOverride,
} from "../src/model/types";
import { TAX_PARAM_FIELDS, type TaxParamFields } from "../src/tax/taxParams";

export const PERSON_IDS: PersonId[] = ["nick", "tracy"];

/** DATE/BIT/FLOAT columns come back from the driver as Date/boolean/number, but
 *  tolerate string forms too so the mapping is not coupled to driver settings. */
type SqlDate = Date | string;
type SqlBool = boolean | number | string;
type SqlNum = number | string;

export interface ScenarioRow {
  id: string;
  name: string;
  startDate: SqlDate;
  linkPreRetirement: SqlBool;
  investmentGrowth: SqlNum;
  savingsInterest: SqlNum;
  inflation: SqlNum;
  giltCoupon: SqlNum;
  giaDividendYield: SqlNum;
  incomeMode: string;
  incomeBaseAnnual: SqlNum;
  incomeSwrRate: SqlNum;
  incomeStartYear: SqlNum;
  incomeYears: SqlNum;
  incomeGrowth: SqlNum;
  bufferYears: SqlNum;
  autoStrategy: SqlBool;
  fillPersonalAllowanceFromPension: SqlBool;
  preserveIsa: SqlBool;
  giltLadderYears: SqlNum;
  taxMode: string;
  lifetimeFillFraction: SqlNum | null;
  taxFreezeUntilYear: SqlNum;
  taxIndexation: string;
  taxUprating: SqlNum;
  finalIncomeDate: SqlDate;
  married: SqlBool;
  statePensionGrowth: SqlNum | null;
  schemaVersion: SqlNum;
  sortOrder: number;
}

export interface PersonRow {
  scenarioId: string;
  personId: string;
  name: string;
  dob: SqlDate;
  pensionAccessAge: SqlNum;
  statePensionAge: SqlNum | null;
  statePensionAnnual: SqlNum;
  lumpSumAllowanceUsed: SqlNum;
  isa: SqlNum;
  pension: SqlNum;
  gia: SqlNum;
  savings: SqlNum;
  gilts: SqlNum;
  giaGainFraction: SqlNum;
  finalIncomeNet: SqlNum;
  finalIncomeTax: SqlNum;
}

/** One year's tax-parameter edits: a column per field, NULL where the user didn't edit it
 *  (that field follows the projected default). */
export type TaxParamsRow = { scenarioId: string; year: SqlNum } & {
  [K in keyof TaxParamFields]: SqlNum | null;
};

export interface OverrideRow {
  scenarioId: string;
  overrideKey: string;
  amount: SqlNum;
}

export interface PurchaseRow {
  scenarioId: string;
  purchaseId: string;
  label: string;
  purchaseDate: SqlDate;
  amount: SqlNum;
  sortOrder: number;
}

export interface ScenarioRows {
  scenario: ScenarioRow;
  people: PersonRow[];
  taxParams: TaxParamsRow[];
  overrides: OverrideRow[];
  purchases: PurchaseRow[];
}

function iso(v: SqlDate): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function num(v: SqlNum | null | undefined): number {
  return typeof v === "number" ? v : Number(v);
}

function bool(v: SqlBool): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function scenarioToRows(s: Scenario, sortOrder: number): ScenarioRows {
  return {
    scenario: {
      id: s.id,
      name: s.name,
      startDate: s.startDate,
      linkPreRetirement: s.linkPreRetirement,
      investmentGrowth: s.rates.investmentGrowth,
      savingsInterest: s.rates.savingsInterest,
      inflation: s.rates.inflation,
      giltCoupon: s.rates.giltCoupon,
      giaDividendYield: s.rates.giaDividendYield,
      incomeMode: s.income.mode,
      incomeBaseAnnual: s.income.baseAnnual,
      incomeSwrRate: s.income.swrRate,
      incomeStartYear: s.income.startYear,
      incomeYears: s.income.years,
      incomeGrowth: s.income.growth,
      bufferYears: s.strategy.bufferYears,
      autoStrategy: s.strategy.autoStrategy,
      fillPersonalAllowanceFromPension: s.strategy.fillPersonalAllowanceFromPension,
      preserveIsa: s.strategy.preserveIsa,
      giltLadderYears: s.strategy.giltLadderYears,
      taxMode: s.strategy.taxMode,
      lifetimeFillFraction: s.strategy.lifetimeFillFraction ?? null,
      taxFreezeUntilYear: s.taxPolicy.freezeUntilYear,
      taxIndexation: s.taxPolicy.indexation,
      taxUprating: s.taxPolicy.uprating,
      finalIncomeDate: s.finalIncome.date,
      married: s.married,
      statePensionGrowth: s.rates.statePensionGrowth,
      schemaVersion: s.schemaVersion,
      sortOrder,
    },
    people: PERSON_IDS.map((pid) => ({
      scenarioId: s.id,
      personId: pid,
      name: s.people[pid].name,
      dob: s.people[pid].dob,
      pensionAccessAge: s.people[pid].pensionAccessAge,
      statePensionAge: s.people[pid].statePensionAge,
      statePensionAnnual: s.people[pid].statePensionAnnual,
      lumpSumAllowanceUsed: s.people[pid].lumpSumAllowanceUsed,
      isa: s.balances[pid].isa,
      pension: s.balances[pid].pension,
      gia: s.balances[pid].gia,
      savings: s.balances[pid].savings,
      gilts: s.balances[pid].gilts,
      giaGainFraction: s.balances[pid].giaGainFraction,
      finalIncomeNet: s.finalIncome.perPerson[pid].net,
      finalIncomeTax: s.finalIncome.perPerson[pid].tax,
    })),
    taxParams: s.taxParams.map((tp) => {
      const row = { scenarioId: s.id, year: tp.year } as TaxParamsRow;
      for (const f of TAX_PARAM_FIELDS) row[f] = tp[f] ?? null;
      return row;
    }),
    overrides: s.overrides.map((o) => ({
      scenarioId: s.id,
      overrideKey: o.key,
      amount: o.amount,
    })),
    purchases: s.purchases.map((p, i) => ({
      scenarioId: s.id,
      purchaseId: p.id,
      label: p.label,
      purchaseDate: p.date,
      amount: p.amount,
      sortOrder: i,
    })),
  };
}

export function rowsToScenario(r: ScenarioRows): Scenario {
  const sc = r.scenario;
  const person = (pid: PersonId): PersonRow => {
    const row = r.people.find((p) => p.personId === pid);
    if (!row) throw new Error(`Scenario ${sc.id} is missing its "${pid}" person row`);
    return row;
  };
  const [nick, tracy] = [person("nick"), person("tracy")];

  const toPerson = (pid: PersonId, row: PersonRow) => ({
    id: pid,
    name: row.name,
    dob: iso(row.dob),
    pensionAccessAge: num(row.pensionAccessAge),
    statePensionAge: row.statePensionAge == null ? null : num(row.statePensionAge),
    statePensionAnnual: num(row.statePensionAnnual),
    lumpSumAllowanceUsed: num(row.lumpSumAllowanceUsed ?? 0),
  });
  const toBalances = (row: PersonRow) => ({
    isa: num(row.isa),
    pension: num(row.pension),
    gia: num(row.gia),
    savings: num(row.savings),
    gilts: num(row.gilts),
    giaGainFraction: num(row.giaGainFraction),
  });

  const scenario: Scenario = {
    id: sc.id,
    name: sc.name,
    startDate: iso(sc.startDate),
    linkPreRetirement: bool(sc.linkPreRetirement),
    people: { nick: toPerson("nick", nick), tracy: toPerson("tracy", tracy) },
    balances: { nick: toBalances(nick), tracy: toBalances(tracy) },
    rates: {
      investmentGrowth: num(sc.investmentGrowth),
      savingsInterest: num(sc.savingsInterest),
      inflation: num(sc.inflation),
      giltCoupon: num(sc.giltCoupon),
      giaDividendYield: num(sc.giaDividendYield),
      statePensionGrowth: sc.statePensionGrowth == null ? null : num(sc.statePensionGrowth),
    },
    income: {
      mode: sc.incomeMode as Scenario["income"]["mode"],
      baseAnnual: num(sc.incomeBaseAnnual),
      swrRate: num(sc.incomeSwrRate),
      startYear: num(sc.incomeStartYear),
      years: num(sc.incomeYears),
      growth: num(sc.incomeGrowth),
    },
    strategy: {
      bufferYears: num(sc.bufferYears),
      autoStrategy: bool(sc.autoStrategy),
      fillPersonalAllowanceFromPension: bool(sc.fillPersonalAllowanceFromPension),
      preserveIsa: bool(sc.preserveIsa),
      giltLadderYears: num(sc.giltLadderYears),
      taxMode: sc.taxMode as Scenario["strategy"]["taxMode"],
    },
    finalIncome: {
      date: iso(sc.finalIncomeDate),
      perPerson: {
        nick: { net: num(nick.finalIncomeNet), tax: num(nick.finalIncomeTax) },
        tracy: { net: num(tracy.finalIncomeNet), tax: num(tracy.finalIncomeTax) },
      },
    },
    taxPolicy: {
      freezeUntilYear: num(sc.taxFreezeUntilYear),
      // Rows written before indexation existed read as "custom"; migrateScenario re-derives
      // the policy for those (schemaVersion 1) from their freeze year and uprating.
      indexation: (sc.taxIndexation ?? "custom") as TaxPolicy["indexation"],
      uprating: num(sc.taxUprating),
    },
    taxParams: [...r.taxParams]
      .sort((a, b) => num(a.year) - num(b.year))
      .map((tp): TaxYearOverride => {
        const out: TaxYearOverride = { year: num(tp.year) };
        for (const f of TAX_PARAM_FIELDS) {
          const v = tp[f];
          if (v != null) out[f] = num(v);
        }
        return out;
      }),
    overrides: r.overrides.map((o): Override => ({ key: o.overrideKey, amount: num(o.amount) })),
    purchases: [...r.purchases]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p): OneOffPurchase => ({
        id: p.purchaseId,
        label: p.label,
        date: iso(p.purchaseDate),
        amount: num(p.amount),
      })),
    married: bool(sc.married ?? false),
    schemaVersion: num(sc.schemaVersion ?? 1),
  };

  if (sc.lifetimeFillFraction != null) {
    scenario.strategy.lifetimeFillFraction = num(sc.lifetimeFillFraction);
  }
  return scenario;
}
