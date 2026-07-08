// Local persistence API for the retirement forecast app.
//
// The SPA cannot talk to SQL Server from the browser, so this small Express
// server owns the database. Run alongside Vite via `npm run dev` (or on its
// own with `npm run server`); the Vite dev server proxies /api here.

import express from "express";
import type { NextFunction, Request, Response } from "express";
import { DB_NAME, getPool } from "./db";
import { deleteScenario, loadState, replaceAll, setActiveId, upsertScenario } from "./repo";
import { migrateScenario } from "../src/model/migrate";
import type { Scenario } from "../src/model/types";

const PORT = Number(process.env.PORT ?? 5174);

export const BACKUP_FORMAT = "retirement-forecast-backup";

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt?: string;
  activeId: string | null;
  scenarios: Scenario[];
}

function assertScenario(body: unknown): Scenario {
  const s = body as Scenario;
  if (!s || typeof s.id !== "string" || !s.people || !s.balances || !s.rates || !s.income || !s.strategy || !s.finalIncome) {
    throw Object.assign(new Error("Body is not a Scenario"), { status: 400 });
  }
  return migrateScenario(s);
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

app.get("/api/export", async (_req, res) => {
  const state = await loadState(await getPool());
  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    activeId: state.activeId,
    scenarios: state.scenarios,
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
