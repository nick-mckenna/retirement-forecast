import type { PersonId } from "../model/types";

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
