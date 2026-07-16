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
        accountId: t.accountId,
      }),
    ),
    income: templates.income.map(
      (t): MonthIncomeItem => ({
        id: `${key}:${t.id}`,
        templateId: t.id,
        name: t.name,
        amount: t.amount,
        accountId: t.accountId,
      }),
    ),
  };
}

/** Months lying strictly after `todayKey`, chronologically. The current month and
 *  the past are the record of what actually happened, so only these are safe to
 *  rewrite from the standard items. */
export function futureMonths(d: ExpenseData, todayKey: string): ExpenseMonth[] {
  return sortedMonths(d).filter((m) => m.key > todayKey);
}

/** Re-sync one month's lines to the standard items: every template-linked line
 *  matches its template exactly and follows the template's order, lines whose
 *  template has been deleted are dropped, and one-offs added to the month are
 *  kept after them. The month's own facts survive — start balance, current
 *  balance, and what has actually been paid. Reusing the deterministic
 *  `${key}:${templateId}` id of `createMonthFromTemplates` makes this idempotent. */
export function applyTemplatesToMonth(templates: ExpenseTemplates, m: ExpenseMonth): ExpenseMonth {
  const paidFor = new Map(m.expenses.map((e) => [e.templateId, e.paid] as const));
  return {
    ...m,
    expenses: [
      ...templates.expenses.map(
        (t): MonthExpenseItem => ({
          id: `${m.key}:${t.id}`,
          templateId: t.id,
          name: t.name,
          day: t.day,
          amount: t.amount,
          // Clamped, not carried: a paid figure left above the new amount would
          // make summariseMonth report a negative "to pay", inflating the
          // predicted balance and hiding the below-zero warning.
          paid: Math.min(paidFor.get(t.id) ?? 0, t.amount),
          accountId: t.accountId,
        }),
      ),
      // A line with no templateId is a one-off added to this month; it is the
      // month's own and survives. `== null` also covers saves from before
      // templateId existed, which would otherwise look like an orphan and be dropped.
      ...m.expenses.filter((e) => e.templateId == null),
    ],
    income: [
      ...templates.income.map(
        (t): MonthIncomeItem => ({
          id: `${m.key}:${t.id}`,
          templateId: t.id,
          name: t.name,
          amount: t.amount,
          accountId: t.accountId,
        }),
      ),
      ...m.income.filter((i) => i.templateId == null),
    ],
  };
}

/** The whole months list with every future month re-synced to the standard items
 *  and its start balance re-chained from the month before — the same chaining the
 *  store does when it creates a month. Single forward pass, so month N chains off
 *  an already-resynced N−1; `prev` is the previous month in the list rather than
 *  the previous *future* month, so the first future month chains off the current
 *  (untouched) one. The result is sorted, which also hands back past months as new
 *  objects — harmless, nothing depends on their identity. */
export function applyTemplatesToFutureMonths(d: ExpenseData, todayKey: string): ExpenseMonth[] {
  const out: ExpenseMonth[] = [];
  for (const m of sortedMonths(d)) {
    const prev = out[out.length - 1];
    if (m.key <= todayKey) {
      out.push(m);
      continue;
    }
    const synced = applyTemplatesToMonth(d.templates, m);
    // Only the very first month has nothing to chain from: it keeps its own start
    // balance, which is the opening balance the user entered.
    out.push(prev ? { ...synced, startBalance: round2(summariseMonth(prev).headroom) } : synced);
  }
  return out;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
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

/** Every month key from `fromKey` to `toKey` inclusive; [] when from > to. */
export function monthKeysBetween(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  for (let k = fromKey; k <= toKey; k = addMonths(k, 1)) keys.push(k);
  return keys;
}

/** Number of calendar days in a "yyyy-mm" month. */
export function daysInMonth(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
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

/** The month the UI should show by default: `todayKey` (the current calendar
 *  month) when tracked, otherwise the nearest tracked month — the latest past
 *  month, or the first future one when the whole list lies ahead. */
export function defaultMonthKey(d: ExpenseData, todayKey: string): string | null {
  const months = sortedMonths(d);
  if (months.length === 0) return null;
  const past = months.filter((m) => m.key <= todayKey);
  return past.length > 0 ? past[past.length - 1].key : months[0].key;
}
