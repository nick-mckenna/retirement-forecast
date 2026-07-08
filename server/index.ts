// Local persistence API for the retirement forecast app.
//
// The SPA cannot talk to SQL Server from the browser, so this small Express
// server owns the database. Run alongside Vite via `npm run dev` (or on its
// own with `npm run server`); the Vite dev server proxies /api here.

import express from "express";
import type { NextFunction, Request, Response } from "express";
import { DB_NAME, getPool } from "./db";
import { deleteScenario, loadState, replaceAll, setActiveId, upsertScenario } from "./repo";
import {
  deleteMonth,
  loadExpenseData,
  replaceAllExpenses,
  replaceTemplates,
  upsertMonth,
} from "./expenseRepo";
import { migrateExpenseData, migrateScenario } from "../src/model/migrate";
import { isMonthKey } from "../src/expenses/calc";
import type { Scenario } from "../src/model/types";
import type { ExpenseData, ExpenseMonth, ExpenseTemplates } from "../src/model/expenseTypes";

const PORT = Number(process.env.PORT ?? 5174);

export const BACKUP_FORMAT = "retirement-forecast-backup";

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt?: string;
  activeId: string | null;
  scenarios: Scenario[];
  /** Added later; absent from older backups (which then leave expenses untouched). */
  expenses?: ExpenseData;
}

function assertScenario(body: unknown): Scenario {
  const s = body as Scenario;
  if (!s || typeof s.id !== "string" || !s.people || !s.balances || !s.rates || !s.income || !s.strategy || !s.finalIncome) {
    throw Object.assign(new Error("Body is not a Scenario"), { status: 400 });
  }
  return migrateScenario(s);
}

function assertTemplates(body: unknown): ExpenseTemplates {
  const t = body as ExpenseTemplates;
  if (!t || !Array.isArray(t.expenses) || !Array.isArray(t.income)) {
    throw Object.assign(new Error("Body is not an expense template set"), { status: 400 });
  }
  return t;
}

function assertExpenseMonth(body: unknown): ExpenseMonth {
  const m = body as ExpenseMonth;
  if (
    !m ||
    typeof m.key !== "string" ||
    !isMonthKey(m.key) ||
    typeof m.startBalance !== "number" ||
    !Array.isArray(m.expenses) ||
    !Array.isArray(m.income)
  ) {
    throw Object.assign(new Error("Body is not an expense month"), { status: 400 });
  }
  return m;
}

function assertExpenseData(body: unknown): ExpenseData {
  const d = body as ExpenseData;
  if (!d || !d.templates || !Array.isArray(d.months)) {
    throw Object.assign(new Error("Body is not expense-tracker data"), { status: 400 });
  }
  assertTemplates(d.templates);
  d.months.forEach(assertExpenseMonth);
  return migrateExpenseData(d);
}

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/api/health", async (_req, res) => {
  const pool = await getPool();
  await pool.request().query("SELECT 1 AS ok");
  res.json({ ok: true, database: DB_NAME });
});

app.get("/api/state", async (_req, res) => {
  const state = await loadState(await getPool());
  res.json(state);
});

app.put("/api/scenarios/:id", async (req, res) => {
  const { scenario, sortOrder } = req.body as { scenario: unknown; sortOrder?: number };
  const s = assertScenario(scenario);
  if (s.id !== req.params.id) {
    throw Object.assign(new Error("Scenario id does not match the URL"), { status: 400 });
  }
  await upsertScenario(await getPool(), s, typeof sortOrder === "number" ? sortOrder : undefined);
  res.status(204).end();
});

app.delete("/api/scenarios/:id", async (req, res) => {
  await deleteScenario(await getPool(), req.params.id);
  res.status(204).end();
});

app.put("/api/active", async (req, res) => {
  const { activeId } = req.body as { activeId: string | null };
  await setActiveId(await getPool(), activeId ?? null);
  res.status(204).end();
});

// ---- Monthly expense tracker (global data, independent of scenarios) ----

app.get("/api/expenses", async (_req, res) => {
  res.json(await loadExpenseData(await getPool()));
});

app.put("/api/expenses/templates", async (req, res) => {
  const { templates } = req.body as { templates: unknown };
  await replaceTemplates(await getPool(), assertTemplates(templates));
  res.status(204).end();
});

app.put("/api/expenses/months/:key", async (req, res) => {
  const { month } = req.body as { month: unknown };
  const m = assertExpenseMonth(month);
  if (m.key !== req.params.key) {
    throw Object.assign(new Error("Month key does not match the URL"), { status: 400 });
  }
  await upsertMonth(await getPool(), m);
  res.status(204).end();
});

app.delete("/api/expenses/months/:key", async (req, res) => {
  if (!isMonthKey(req.params.key)) {
    throw Object.assign(new Error("Not a month key (yyyy-mm)"), { status: 400 });
  }
  await deleteMonth(await getPool(), req.params.key);
  res.status(204).end();
});

app.get("/api/export", async (_req, res) => {
  const pool = await getPool();
  const state = await loadState(pool);
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    activeId: state.activeId,
    scenarios: state.scenarios,
    expenses: await loadExpenseData(pool),
  };
  res.json(backup);
});

app.post("/api/import", async (req, res) => {
  const backup = req.body as BackupFile;
  if (backup?.format !== BACKUP_FORMAT || !Array.isArray(backup.scenarios) || backup.scenarios.length === 0) {
    throw Object.assign(new Error("Body is not a retirement-forecast backup file"), { status: 400 });
  }
  const scenarios = backup.scenarios.map(assertScenario);
  const pool = await getPool();
  await replaceAll(pool, { scenarios, activeId: backup.activeId ?? null });
  // Older backups have no expense data; leave the tracker untouched for those.
  if (backup.expenses) await replaceAllExpenses(pool, assertExpenseData(backup.expenses));
  res.json(await loadState(pool));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(err.status ?? 500).json({ error: err.message });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Forecast API listening on http://127.0.0.1:${PORT} (database: ${DB_NAME})`);
});
