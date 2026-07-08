// Data access: Scenario CRUD + app state, built on the pure mapping layer.

import { sql } from "./db";
import type { Scenario } from "../src/model/types";
import {
  rowsToScenario,
  scenarioToRows,
  type OverrideRow,
  type PersonRow,
  type PurchaseRow,
  type ScenarioRow,
  type TaxParamsRow,
} from "./mapping";

export interface PersistedState {
  scenarios: Scenario[];
  activeId: string | null;
}

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

async function insertScenario(
  tx: InstanceType<typeof sql.Transaction>,
  s: Scenario,
  sortOrder: number,
): Promise<void> {
  const rows = scenarioToRows(s, sortOrder);
  await insertRow(tx, "Scenario", rows.scenario as unknown as Record<string, unknown>);
  for (const p of rows.people) await insertRow(tx, "ScenarioPerson", p as unknown as Record<string, unknown>);
  for (const t of rows.taxParams) await insertRow(tx, "ScenarioTaxYearParams", t as unknown as Record<string, unknown>);
  for (const o of rows.overrides) await insertRow(tx, "ScenarioOverride", o as unknown as Record<string, unknown>);
  for (const p of rows.purchases) await insertRow(tx, "ScenarioPurchase", p as unknown as Record<string, unknown>);
}

export async function loadState(pool: sql.ConnectionPool): Promise<PersistedState> {
  const [sc, pe, tp, ov, pu, st] = await Promise.all([
    pool.request().query<ScenarioRow>("SELECT * FROM dbo.Scenario ORDER BY sortOrder, name"),
    pool.request().query<PersonRow>("SELECT * FROM dbo.ScenarioPerson"),
    pool.request().query<TaxParamsRow>("SELECT * FROM dbo.ScenarioTaxYearParams"),
    pool.request().query<OverrideRow>("SELECT * FROM dbo.ScenarioOverride"),
    pool.request().query<PurchaseRow>("SELECT * FROM dbo.ScenarioPurchase"),
    pool.request().query<{ activeScenarioId: string | null }>(
      "SELECT activeScenarioId FROM dbo.AppState WHERE id = 1",
    ),
  ]);

  const byScenario = <T extends { scenarioId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.scenarioId) ?? [];
      list.push(r);
      m.set(r.scenarioId, list);
    }
    return m;
  };
  const people = byScenario(pe.recordset);
  const taxParams = byScenario(tp.recordset);
  const overrides = byScenario(ov.recordset);
  const purchases = byScenario(pu.recordset);

  const scenarios = sc.recordset.map((row) =>
    rowsToScenario({
      scenario: row,
      people: people.get(row.id) ?? [],
      taxParams: taxParams.get(row.id) ?? [],
      overrides: overrides.get(row.id) ?? [],
      purchases: purchases.get(row.id) ?? [],
    }),
  );

  let activeId = st.recordset[0]?.activeScenarioId ?? null;
  if (activeId && !scenarios.some((s) => s.id === activeId)) activeId = null;
  if (!activeId && scenarios.length > 0) activeId = scenarios[0].id;
  return { scenarios, activeId };
}

export async function upsertScenario(
  pool: sql.ConnectionPool,
  s: Scenario,
  sortOrder?: number,
): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const existing = await new sql.Request(tx)
      .input("id", s.id)
      .query<{ sortOrder: number }>("SELECT sortOrder FROM dbo.Scenario WHERE id = @id");
    let order = sortOrder ?? existing.recordset[0]?.sortOrder;
    if (order == null) {
      const next = await new sql.Request(tx).query<{ next: number }>(
        "SELECT ISNULL(MAX(sortOrder), -1) + 1 AS next FROM dbo.Scenario",
      );
      order = next.recordset[0].next;
    }
    await new sql.Request(tx).input("id", s.id).query("DELETE FROM dbo.Scenario WHERE id = @id");
    await insertScenario(tx, s, order);
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function deleteScenario(pool: sql.ConnectionPool, id: string): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).input("id", id).query("DELETE FROM dbo.Scenario WHERE id = @id");
    await new sql.Request(tx)
      .input("id", id)
      .query("UPDATE dbo.AppState SET activeScenarioId = NULL WHERE activeScenarioId = @id");
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function setActiveId(pool: sql.ConnectionPool, activeId: string | null): Promise<void> {
  await pool
    .request()
    .input("activeId", activeId)
    .query(
      `MERGE dbo.AppState AS t USING (SELECT 1 AS id) AS s ON t.id = s.id
       WHEN MATCHED THEN UPDATE SET activeScenarioId = @activeId
       WHEN NOT MATCHED THEN INSERT (id, activeScenarioId) VALUES (1, @activeId);`,
    );
}

/** Restore a backup: replace every scenario and the active pointer atomically. */
export async function replaceAll(pool: sql.ConnectionPool, state: PersistedState): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query("DELETE FROM dbo.AppState");
    await new sql.Request(tx).query("DELETE FROM dbo.Scenario");
    for (let i = 0; i < state.scenarios.length; i++) {
      await insertScenario(tx, state.scenarios[i], i);
    }
    const activeId =
      state.activeId && state.scenarios.some((s) => s.id === state.activeId)
        ? state.activeId
        : state.scenarios[0]?.id ?? null;
    await new sql.Request(tx)
      .input("activeId", activeId)
      .query("INSERT INTO dbo.AppState (id, activeScenarioId) VALUES (1, @activeId)");
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
