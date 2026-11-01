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
  /** Still to go out this month: Σ max(0, amount − paid) — a line paid above its amount
   *  has nothing left to pay, it doesn't offset the others. */
  totalToPay: number;
  /** Income excluding the start balance (expected amounts). */
  totalIncome: number;
  /** Income actually received so far. */
  totalReceived: number;
  /** Income still to come this month: Σ max(0, amount − received). */
  totalToReceive: number;
  /** Start balance + income (the sheet's income-side Total), counting any line received
   *  above its expected amount at what actually arrived. */
  totalAvailable: number;
  /** The expected end-of-month balance (the sheet's "Balance To Reach 0"): totalAvailable less
   *  every expense at the larger of its expected and paid amounts. Negative ⇒ the account would
   *  go below zero this month. */
  headroom: number;
  /** currentBalance − still to pay + still to come, or null until a current balance is entered. */
  predicted: number | null;
}

/** What is still to pay on one expense line (never negative). */
export function lineToPay(e: MonthExpenseItem): number {
  return Math.max(0, e.amount - e.paid);
}

/** What is still to come on one income line (never negative). */
export function lineToReceive(i: MonthIncomeItem): number {
  return Math.max(0, i.amount - i.received);
}

export function summariseMonth(m: ExpenseMonth): MonthSummary {
  const totalExpenses = m.expenses.reduce((s, e) => s + e.amount, 0);
  const totalPaid = m.expenses.reduce((s, e) => s + e.paid, 0);
  const totalToPay = m.expenses.reduce((s, e) => s + lineToPay(e), 0);
  const totalIncome = m.income.reduce((s, i) => s + i.amount, 0);
  const totalReceived = m.income.reduce((s, i) => s + i.received, 0);
  const totalToReceive = m.income.reduce((s, i) => s + lineToReceive(i), 0);
  const totalAvailable = m.startBalance + m.income.reduce((s, i) => s + Math.max(i.amount, i.received), 0);
  const totalOut = m.expenses.reduce((s, e) => s + Math.max(e.amount, e.paid), 0);
  return {
    totalExpenses,
    totalPaid,
    totalToPay,
    totalIncome,
    totalReceived,
    totalToReceive,
    totalAvailable,
    headroom: totalAvailable - totalOut,
    predicted: m.currentBalance == null ? null : m.currentBalance - totalToPay + totalToReceive,
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
  startBalancePinned = false,
): ExpenseMonth {
  return {
    key,
    startBalance,
    startBalancePinned,
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
        received: 0,
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
  const receivedFor = new Map(m.income.map((i) => [i.templateId, i.received] as const));
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
          // Carried as is: what was paid is a fact. A line paid above its new amount
          // just has nothing left to pay (summariseMonth clamps per line).
          paid: paidFor.get(t.id) ?? 0,
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
          received: receivedFor.get(t.id) ?? 0,
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
  const synced = sortedMonths(d).map((m) => (m.key > todayKey ? applyTemplatesToMonth(d.templates, m) : m));
  return rechainStartBalances(synced).months;
}

/**
 * Carry each month's start balance forward from the previous month's expected end, in one
 * forward pass — except where the user typed it (`startBalancePinned`), or there is no
 * immediately preceding month to carry from (the first month, or one after a gap). Returns
 * the sorted months and the keys whose start balance changed (the only ones to save).
 */
export function rechainStartBalances(months: ExpenseMonth[]): { months: ExpenseMonth[]; changed: string[] } {
  const sorted = [...months].sort((a, b) => a.key.localeCompare(b.key));
  const out: ExpenseMonth[] = [];
  const changed: string[] = [];
  for (const m of sorted) {
    const prev = out[out.length - 1];
    if (prev && !m.startBalancePinned && prev.key === addMonths(m.key, -1)) {
      const carried = round2(summariseMonth(prev).headroom);
      if (Math.abs(carried - m.startBalance) > 0.005) {
        out.push({ ...m, startBalance: carried });
        changed.push(m.key);
        continue;
      }
    }
    out.push(m);
  }
  return { months: out, changed };
}

/**
 * For data saved before start balances could be pinned: a month counts as pinned (typed by
 * the user) unless its stored start balance equals what carrying forward from the month
 * before gives — so nothing anyone typed is ever rewritten. The first month, and any after a
 * gap, are always pinned. `isLegacy` picks the months to resolve; the rest keep their flag.
 */
export function resolveLegacyPins(months: ExpenseMonth[], isLegacy: (m: ExpenseMonth) => boolean): ExpenseMonth[] {
  const sorted = [...months].sort((a, b) => a.key.localeCompare(b.key));
  return sorted.map((m, i) => {
    if (!isLegacy(m)) return m;
    const prev = sorted[i - 1];
    const chained = prev && prev.key === addMonths(m.key, -1) ? round2(summariseMonth(prev).headroom) : null;
    return { ...m, startBalancePinned: chained == null || Math.abs(chained - m.startBalance) > 0.005 };
  });
}

/** Every month from `fromKey` to `untilKey` that isn't tracked yet, created from the standard
 *  items with carried-forward start balances — gaps and months before the first included. */
export function fillMissingMonths(d: ExpenseData, fromKey: string, untilKey: string): { months: ExpenseMonth[]; added: string[] } {
  const have = new Set(d.months.map((m) => m.key));
  const added = monthKeysBetween(fromKey, untilKey).filter((k) => !have.has(k));
  const created = added.map((k) => createMonthFromTemplates(d.templates, k));
  return { months: rechainStartBalances([...d.months, ...created]).months, added };
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

/** Upper bound on any month range (200 years) — a guard, never a real limit. */
const MAX_MONTH_RANGE = 2400;

function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
}

/** Every month key from `fromKey` to `toKey` inclusive; [] when from > to or either key is
 *  not a valid "yyyy-mm" (e.g. derived from an empty date). Counted, not compared as
 *  strings, so a malformed key can never make it loop forever. */
export function monthKeysBetween(fromKey: string, toKey: string): string[] {
  if (!isMonthKey(fromKey) || !isMonthKey(toKey)) return [];
  const count = Math.min(monthIndex(toKey) - monthIndex(fromKey) + 1, MAX_MONTH_RANGE);
  const keys: string[] = [];
  for (let i = 0, k = fromKey; i < count; i++, k = addMonths(k, 1)) keys.push(k);
  return keys;
}

/** Number of calendar days in a "yyyy-mm" month. */
export function daysInMonth(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** A day-of-month clamped into the month: a due day of 29–31 lands on the last day of a
 *  shorter month, and null (no day given) means the month's last day. */
export function clampDay(day: number | null | undefined, monthKey: string): number {
  const dim = daysInMonth(monthKey);
  return Math.min(Math.max(day ?? dim, 1), dim);
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
