// Pure mapping between the expense-tracker domain objects and the normalized
// SQL rows, mirroring server/mapping.ts for scenarios. No DB or Node
// dependencies so it can be unit-tested alongside the calc layer.
//
// Every user-editable expense field must appear here exactly once in each
// direction; the round-trip test in src/__tests__/expenseMapping.test.ts guards that.

import type {
  ExpenseData,
  ExpenseMonth,
  ExpenseTemplates,
} from "../src/model/expenseTypes";

type SqlNum = number | string;

export interface ExpenseTemplateRow {
  kind: "expense" | "income";
  itemId: string;
  name: string;
  dayOfMonth: SqlNum | null;
  amount: SqlNum;
  accountId: string | null;
  sortOrder: number;
}

export interface ExpenseMonthRow {
  monthKey: string;
  startBalance: SqlNum;
  currentBalance: SqlNum | null;
}

export interface ExpenseMonthItemRow {
  monthKey: string;
  kind: "expense" | "income";
  itemId: string;
  templateId: string | null;
  name: string;
  dayOfMonth: SqlNum | null;
  amount: SqlNum;
  paid: SqlNum | null;
  accountId: string | null;
  sortOrder: number;
}

export interface ExpenseRows {
  templates: ExpenseTemplateRow[];
  months: ExpenseMonthRow[];
  items: ExpenseMonthItemRow[];
}

function num(v: SqlNum): number {
  return typeof v === "number" ? v : Number(v);
}

function numOrNull(v: SqlNum | null | undefined): number | null {
  return v == null ? null : num(v);
}

export function templatesToRows(t: ExpenseTemplates): ExpenseTemplateRow[] {
  return [
    ...t.expenses.map(
      (e, i): ExpenseTemplateRow => ({
        kind: "expense",
        itemId: e.id,
        name: e.name,
        dayOfMonth: e.day,
        amount: e.amount,
        accountId: e.accountId ?? null,
        sortOrder: i,
      }),
    ),
    ...t.income.map(
      (inc, i): ExpenseTemplateRow => ({
        kind: "income",
        itemId: inc.id,
        name: inc.name,
        dayOfMonth: null,
        amount: inc.amount,
        accountId: inc.accountId ?? null,
        sortOrder: i,
      }),
    ),
  ];
}

export function rowsToTemplates(rows: ExpenseTemplateRow[]): ExpenseTemplates {
  const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    expenses: sorted
      .filter((r) => r.kind === "expense")
      .map((r) => ({
        id: r.itemId,
        name: r.name,
        day: numOrNull(r.dayOfMonth),
        amount: num(r.amount),
        accountId: r.accountId ?? null,
      })),
    income: sorted
      .filter((r) => r.kind === "income")
      .map((r) => ({ id: r.itemId, name: r.name, amount: num(r.amount), accountId: r.accountId ?? null })),
  };
}

export function monthToRows(m: ExpenseMonth): { month: ExpenseMonthRow; items: ExpenseMonthItemRow[] } {
  return {
    month: {
      monthKey: m.key,
      startBalance: m.startBalance,
      currentBalance: m.currentBalance,
    },
    items: [
      ...m.expenses.map(
        (e, i): ExpenseMonthItemRow => ({
          monthKey: m.key,
          kind: "expense",
          itemId: e.id,
          templateId: e.templateId,
          name: e.name,
          dayOfMonth: e.day,
          amount: e.amount,
          paid: e.paid,
          accountId: e.accountId ?? null,
          sortOrder: i,
        }),
      ),
      ...m.income.map(
        (inc, i): ExpenseMonthItemRow => ({
          monthKey: m.key,
          kind: "income",
          itemId: inc.id,
          templateId: inc.templateId,
          name: inc.name,
          dayOfMonth: null,
          amount: inc.amount,
          paid: null,
          accountId: inc.accountId ?? null,
          sortOrder: i,
        }),
      ),
    ],
  };
}

export function rowsToMonth(month: ExpenseMonthRow, items: ExpenseMonthItemRow[]): ExpenseMonth {
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    key: month.monthKey,
    startBalance: num(month.startBalance),
    currentBalance: numOrNull(month.currentBalance),
    expenses: sorted
      .filter((r) => r.kind === "expense")
      .map((r) => ({
        id: r.itemId,
        templateId: r.templateId ?? null,
        name: r.name,
        day: numOrNull(r.dayOfMonth),
        amount: num(r.amount),
        paid: num(r.paid ?? 0),
        accountId: r.accountId ?? null,
      })),
    income: sorted
      .filter((r) => r.kind === "income")
      .map((r) => ({
        id: r.itemId,
        templateId: r.templateId ?? null,
        name: r.name,
        amount: num(r.amount),
        accountId: r.accountId ?? null,
      })),
  };
}

export function expenseDataToRows(d: ExpenseData): ExpenseRows {
  const months = d.months.map(monthToRows);
  return {
    templates: templatesToRows(d.templates),
    months: months.map((m) => m.month),
    items: months.flatMap((m) => m.items),
  };
}

export function rowsToExpenseData(r: ExpenseRows): ExpenseData {
  const itemsByMonth = new Map<string, ExpenseMonthItemRow[]>();
  for (const item of r.items) {
    const list = itemsByMonth.get(item.monthKey) ?? [];
    list.push(item);
    itemsByMonth.set(item.monthKey, list);
  }
  return {
    templates: rowsToTemplates(r.templates),
    months: [...r.months]
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map((m) => rowsToMonth(m, itemsByMonth.get(m.monthKey) ?? [])),
  };
}
