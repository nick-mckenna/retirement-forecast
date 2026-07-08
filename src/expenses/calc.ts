// Pure calculations for the monthly expense tracker. No I/O, no store access —
// the UI derives everything through these, mirroring how the retirement engine
// stays pure. The numbers reproduce the Expenditure spreadsheet exactly:
// per-month expense totals (Amount / Paid / To Pay), the income-side total
// (which includes the start balance, as the sheet's SUM does), the headroom
// ("Balance To Reach 0") and the predicted balance (Current − To Pay).

import type {
  ExpenseData,
  ExpenseMonth,
  ExpenseTemplates,
  MonthExpenseItem,
  MonthIncomeItem,
} from "../model/expenseTypes";

export interface MonthSummary {
  /** Sum of expected amounts (sheet: Total of the Amount column). */
  totalExpenses: number;
  /** Sum actually paid so far. */
  totalPaid: number;
  /** Still to go out this month: Σ(amount − paid). */
  totalToPay: number;
  /** Income excluding the start balance. */
  totalIncome: number;
  /** Start balance + income (the sheet's income-side Total). */
  totalAvailable: number;
  /** totalAvailable − totalExpenses: the expected end-of-month balance
   *  (the sheet's "Balance To Reach 0"). Negative ⇒ the account would go
   *  below zero this month. */
  headroom: number;
  /** currentBalance − totalToPay, or null until a current balance is entered. */
  predicted: number | null;
}

export function summariseMonth(m: ExpenseMonth): MonthSummary {
  const totalExpenses = m.expenses.reduce((s, e) => s + e.amount, 0);
  const totalPaid = m.expenses.reduce((s, e) => s + e.paid, 0);
  const totalToPay = totalExpenses - totalPaid;
  const totalIncome = m.income.reduce((s, i) => s + i.amount, 0);
  const totalAvailable = m.startBalance + totalIncome;
  return {
    totalExpenses,
    totalPaid,
    totalToPay,
    totalIncome,
    totalAvailable,
    headroom: totalAvailable - totalExpenses,
    predicted: m.currentBalance == null ? null : m.currentBalance - totalToPay,
  };
}

/** Warnings for a month where the joint account is heading below zero. */
export function monthWarnings(m: ExpenseMonth): string[] {
  const s = summariseMonth(m);
  const w: string[] = [];
  if (s.headroom < 0) {
    w.push(
      `${monthLabel(m.key)}: expenses exceed the start balance plus income by ${Math.abs(s.headroom).toFixed(2)} — the account would end the month below zero.`,
    );
  }
  if (s.predicted != null && s.predicted < 0) {
    w.push(
      `${monthLabel(m.key)}: the remaining payments exceed the current balance by ${Math.abs(s.predicted).toFixed(2)} — top the account up before they go out.`,
    );
  }
  return w;
}

/** Snapshot the standard items into a new month record. */
export function createMonthFromTemplates(
  templates: ExpenseTemplates,
  key: string,
  startBalance = 0,
): ExpenseMonth {
  return {
    key,
    startBalance,
    currentBalance: null,
    expenses: templates.expenses.map(
      (t): MonthExpenseItem => ({
        id: `${key}:${t.id}`,
        templateId: t.id,
        name: t.name,
        day: t.day,
        amount: t.amount,
        paid: 0,
      }),
    ),
    income: templates.income.map(
      (t): MonthIncomeItem => ({
        id: `${key}:${t.id}`,
        templateId: t.id,
        name: t.name,
        amount: t.amount,
      }),
    ),
  };
}

// ---- Month-key helpers ("yyyy-mm") -----------------------------------------

export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(key: string): boolean {
  return MONTH_KEY_RE.test(key);
}

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** "2026-01" → "January 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[(m ?? 1) - 1] ?? "?"} ${y}`;
}

/** Months sorted chronologically (keys sort lexicographically). */
export function sortedMonths(d: ExpenseData): ExpenseMonth[] {
  return [...d.months].sort((a, b) => a.key.localeCompare(b.key));
}

/** The key a newly added month should get: after the latest tracked month,
 *  or `fallback` (normally the current calendar month) when none exist yet. */
export function nextMonthKey(d: ExpenseData, fallback: string): string {
  const months = sortedMonths(d);
  const last = months[months.length - 1];
  return last ? addMonths(last.key, 1) : fallback;
}
