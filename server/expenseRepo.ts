// Data access for the monthly expense tracker, built on the pure mapping
// layer in expenseMapping.ts. Same patterns as repo.ts: delete-then-insert
// upserts inside transactions, parameterized inserts driven by row keys.

import { sql } from "./db";
import type { ExpenseData, ExpenseMonth, ExpenseTemplates } from "../src/model/expenseTypes";
import {
  monthToRows,
  rowsToExpenseData,
  templatesToRows,
  type ExpenseMonthItemRow,
  type ExpenseMonthRow,
  type ExpenseTemplateRow,
} from "./expenseMapping";

/** Column names come from our own row objects, never from user input. */
async function insertRow(
  tx: InstanceType<typeof sql.Transaction>,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const req = new sql.Request(tx);
  const cols = Object.keys(row);
  for (const c of cols) req.input(c, row[c] ?? null);
  await req.query(
    `INSERT INTO dbo.[${table}] (${cols.map((c) => `[${c}]`).join(", ")})
     VALUES (${cols.map((c) => `@${c}`).join(", ")})`,
  );
}

export async function loadExpenseData(pool: sql.ConnectionPool): Promise<ExpenseData> {
  const [templates, months, items] = await Promise.all([
    pool.request().query<ExpenseTemplateRow>("SELECT * FROM dbo.ExpenseTemplate"),
    pool.request().query<ExpenseMonthRow>("SELECT * FROM dbo.ExpenseMonth"),
    pool.request().query<ExpenseMonthItemRow>("SELECT * FROM dbo.ExpenseMonthItem"),
  ]);
  return rowsToExpenseData({
    templates: templates.recordset,
    months: months.recordset,
    items: items.recordset,
  });
}

/** Replace the standard expense/income lists atomically. */
export async function replaceTemplates(
  pool: sql.ConnectionPool,
  templates: ExpenseTemplates,
): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query("DELETE FROM dbo.ExpenseTemplate");
    for (const row of templatesToRows(templates)) {
      await insertRow(tx, "ExpenseTemplate", row as unknown as Record<string, unknown>);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** Upsert one tracked month (delete-then-insert; items cascade). */
export async function upsertMonth(pool: sql.ConnectionPool, m: ExpenseMonth): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input("monthKey", m.key)
      .query("DELETE FROM dbo.ExpenseMonth WHERE monthKey = @monthKey");
    const rows = monthToRows(m);
    await insertRow(tx, "ExpenseMonth", rows.month as unknown as Record<string, unknown>);
    for (const item of rows.items) {
      await insertRow(tx, "ExpenseMonthItem", item as unknown as Record<string, unknown>);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function deleteMonth(pool: sql.ConnectionPool, key: string): Promise<void> {
  await pool
    .request()
    .input("monthKey", key)
    .query("DELETE FROM dbo.ExpenseMonth WHERE monthKey = @monthKey");
}

/** Restore from a backup: replace all expense-tracker data atomically. */
export async function replaceAllExpenses(
  pool: sql.ConnectionPool,
  data: ExpenseData,
): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query("DELETE FROM dbo.ExpenseTemplate");
    await new sql.Request(tx).query("DELETE FROM dbo.ExpenseMonth");
    for (const row of templatesToRows(data.templates)) {
      await insertRow(tx, "ExpenseTemplate", row as unknown as Record<string, unknown>);
    }
    for (const m of data.months) {
      const rows = monthToRows(m);
      await insertRow(tx, "ExpenseMonth", rows.month as unknown as Record<string, unknown>);
      for (const item of rows.items) {
        await insertRow(tx, "ExpenseMonthItem", item as unknown as Record<string, unknown>);
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
