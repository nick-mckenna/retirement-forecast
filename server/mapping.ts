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
  TaxYearParams,
} from "../src/model/types";

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
  finalIncomeDate: SqlDate;
  sortOrder: number;
}

export interface PersonRow {
  scenarioId: string;
  personId: string;
  name: string;
  dob: SqlDate;
  pensionAccessAge: SqlNum;
  statePensionAge: SqlNum;
  statePensionAnnual: SqlNum;
  isa: SqlNum;
  pension: SqlNum;
  gia: SqlNum;
  savings: SqlNum;
  gilts: SqlNum;
  giaGainFraction: SqlNum;
  finalIncomeNet: SqlNum;
  finalIncomeTax: SqlNum;
}

export interface TaxParamsRow {
  scenarioId: string;
  year: SqlNum;
  personalAllowance: SqlNum;
  paTaperThreshold: SqlNum;
  basicRateBand: SqlNum;
  higherRateBand: SqlNum;
  basicRate: SqlNum;
  higherRate: SqlNum;
  additionalRate: SqlNum;
  psaBasic: SqlNum;
  psaHigher: SqlNum;
  savingsStartingRateBand: SqlNum;
  dividendAllowance: SqlNum;
  dividendBasicRate: SqlNum;
  dividendHigherRate: SqlNum;
  dividendAdditionalRate: SqlNum;
  cgtAnnualExempt: SqlNum;
  cgtBasicRate: SqlNum;
  cgtHigherRate: SqlNum;
  isaAllowance: SqlNum;
}

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
      finalIncomeDate: s.finalIncome.date,
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
      isa: s.balances[pid].isa,
      pension: s.balances[pid].pension,
      gia: s.balances[pid].gia,
      savings: s.balances[pid].savings,
      gilts: s.balances[pid].gilts,
      giaGainFraction: s.balances[pid].giaGainFraction,
      finalIncomeNet: s.finalIncome.perPerson[pid].net,
      finalIncomeTax: s.finalIncome.perPerson[pid].tax,
    })),
    taxParams: s.taxParams.map((tp) => ({ scenarioId: s.id, ...tp })),
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
    statePensionAge: num(row.statePensionAge),
    statePensionAnnual: num(row.statePensionAnnual),
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
    people: { nick: toPerson("nick", nick), tracy: toPerson("tracy", tracy) },
    balances: { nick: toBalances(nick), tracy: toBalances(tracy) },
    rates: {
      investmentGrowth: num(sc.investmentGrowth),
      savingsInterest: num(sc.savingsInterest),
      inflation: num(sc.inflation),
      giltCoupon: num(sc.giltCoupon),
      giaDividendYield: num(sc.giaDividendYield),
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
    taxParams: [...r.taxParams]
      .sort((a, b) => num(a.year) - num(b.year))
      .map((tp): TaxYearParams => ({
        year: num(tp.year),
        personalAllowance: num(tp.personalAllowance),
        paTaperThreshold: num(tp.paTaperThreshold),
        basicRateBand: num(tp.basicRateBand),
        higherRateBand: num(tp.higherRateBand),
        basicRate: num(tp.basicRate),
        higherRate: num(tp.higherRate),
        additionalRate: num(tp.additionalRate),
        psaBasic: num(tp.psaBasic),
        psaHigher: num(tp.psaHigher),
        savingsStartingRateBand: num(tp.savingsStartingRateBand),
        dividendAllowance: num(tp.dividendAllowance),
        dividendBasicRate: num(tp.dividendBasicRate),
        dividendHigherRate: num(tp.dividendHigherRate),
        dividendAdditionalRate: num(tp.dividendAdditionalRate),
        cgtAnnualExempt: num(tp.cgtAnnualExempt),
        cgtBasicRate: num(tp.cgtBasicRate),
        cgtHigherRate: num(tp.cgtHigherRate),
        isaAllowance: num(tp.isaAllowance),
      })),
    overrides: r.overrides.map((o): Override => ({ key: o.overrideKey, amount: num(o.amount) })),
    purchases: [...r.purchases]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p): OneOffPurchase => ({
        id: p.purchaseId,
        label: p.label,
        date: iso(p.purchaseDate),
        amount: num(p.amount),
      })),
  };

  if (sc.lifetimeFillFraction != null) {
    scenario.strategy.lifetimeFillFraction = num(sc.lifetimeFillFraction);
  }
  return scenario;
}
