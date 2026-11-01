import type { PersonId } from "../model/types";
import { parseDate, taxYearStartYear } from "../tax/taxYear";

export type RowType = "BALANCE" | "TRANSACTION";

/** The per-person account columns, mirroring the spreadsheet layout. */
export interface PersonColumns {
  income: number;
  isa: number;
  pension: number;
  gia: number;
  savings: number;
  giltsTotal: number;
  tax: number;
}

export interface LedgerRow {
  type: RowType;
  /** Description (column B in the sheet): Starting Balances, Growth, Income, Gilt Purchase, etc. */
  label: string;
  dateIso: string;
  nick: PersonColumns;
  tracy: PersonColumns;
  /** Savings & Gilts buffer = savings + gilts for both people (BALANCE rows only). */
  savingsAndGilts: number;
  /** Net worth = all investment + cash + gilt pots (BALANCE rows only). */
  netWorth: number;
  /** Optional stable id linking a transaction to a strategy decision + override. */
  decisionKey?: string;
}

export function emptyPersonColumns(): PersonColumns {
  return { income: 0, isa: 0, pension: 0, gia: 0, savings: 0, giltsTotal: 0, tax: 0 };
}

export const PERSON_IDS: PersonId[] = ["nick", "tracy"];

/** Labels of the ledger rows that carry income — written by simulate(), read back here to
 *  split each person's income by where it came from. */
export const INCOME_ROW_LABELS = {
  /** The monthly draw of the income target from the buffer (cash, then gilts). */
  drawdown: "Income",
  statePension: "State Pension",
  /** The one-off final employment income (net), in its month. */
  finalIncome: "Final Income",
} as const;

export type IncomeSource = keyof typeof INCOME_ROW_LABELS;
export const INCOME_SOURCES: IncomeSource[] = ["drawdown", "statePension", "finalIncome"];

/** One tax year's income per person, plus the household total. */
export interface AnnualIncome {
  taxYearStart: number;
  nick: number;
  tracy: number;
  total: number;
  /** Each person's income by source; the sources add up to the person's figure. */
  bySource: Record<PersonId, Record<IncomeSource, number>>;
}

function emptySources(): Record<IncomeSource, number> {
  return { drawdown: 0, statePension: 0, finalIncome: 0 };
}

const SOURCE_BY_LABEL = new Map<string, IncomeSource>(
  INCOME_SOURCES.map((s) => [INCOME_ROW_LABELS[s], s] as const),
);

/**
 * Totals the ledger's per-person Income column for each tax year (6 Apr → 5 Apr) — the Ledger
 * tab's Income columns summed over the year: each person's share of the drawn income target,
 * their State Pension and, in its year, the one-off final income — also split by those sources
 * (`bySource`, from the row labels in `INCOME_ROW_LABELS`). Only TRANSACTION rows carry income
 * (BALANCE snapshots hold 0). Returns one entry per year in `taxYears`, in that order; rows
 * dated outside those years are ignored.
 */
export function incomeByTaxYear(rows: LedgerRow[], taxYears: number[]): AnnualIncome[] {
  const byYear = new Map<number, AnnualIncome>(
    taxYears.map((y) => [
      y,
      { taxYearStart: y, nick: 0, tracy: 0, total: 0, bySource: { nick: emptySources(), tracy: emptySources() } },
    ]),
  );
  for (const r of rows) {
    if (r.type !== "TRANSACTION") continue;
    const entry = byYear.get(taxYearStartYear(parseDate(r.dateIso)));
    if (!entry) continue;
    entry.nick += r.nick.income;
    entry.tracy += r.tracy.income;
    const source = SOURCE_BY_LABEL.get(r.label);
    if (source) {
      entry.bySource.nick[source] += r.nick.income;
      entry.bySource.tracy[source] += r.tracy.income;
    }
  }
  for (const e of byYear.values()) e.total = e.nick + e.tracy;
  return taxYears.map((y) => byYear.get(y)!);
}
