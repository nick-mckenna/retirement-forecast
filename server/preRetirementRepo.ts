// Data access for the pre-retirement module, built on the pure mapping layer
// in preRetirementMapping.ts. The whole document is small (a singleton state
// row, a handful of accounts and overrides), so it is always replaced
// atomically as one unit — no per-entity upserts.

import { sql } from "./db";
import type { PreRetirementData } from "../src/model/preRetirementTypes";
import { emptyPreRetirementData } from "../src/model/preRetirementTypes";
import {
  preRetirementToRows,
  rowsToPreRetirement,
  type PreRetirementAccountRow,
  type PreRetirementOverrideRow,
  type PreRetirementStateRow,
} from "./preRetirementMapping";

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

/** Returns an empty document (no accounts) when nothing has been saved yet —
 *  the client store then seeds the database from its local default registry. */
export async function loadPreRetirement(pool: sql.ConnectionPool): Promise<PreRetirementData> {
  const [state, accounts, overrides] = await Promise.all([
    pool.request().query<PreRetirementStateRow>("SELECT * FROM dbo.PreRetirementState"),
    pool.request().query<PreRetirementAccountRow>("SELECT * FROM dbo.PreRetirementAccount"),
    pool.request().query<PreRetirementOverrideRow>("SELECT * FROM dbo.PreRetirementAccountOverride"),
  ]);
  const stateRow = state.recordset[0];
  if (!stateRow) return emptyPreRetirementData();
  return rowsToPreRetirement({
    state: stateRow,
    accounts: accounts.recordset,
    overrides: overrides.recordset,
  });
}

/** Replace the whole pre-retirement document atomically. */
export async function replaceAllPreRetirement(
  pool: sql.ConnectionPool,
  data: PreRetirementData,
): Promise<void> {
  const rows = preRetirementToRows(data);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query("DELETE FROM dbo.PreRetirementState");
    await new sql.Request(tx).query("DELETE FROM dbo.PreRetirementAccount"); // overrides cascade
    await insertRow(tx, "PreRetirementState", rows.state as unknown as Record<string, unknown>);
    for (const a of rows.accounts) {
      await insertRow(tx, "PreRetirementAccount", a as unknown as Record<string, unknown>);
    }
    for (const o of rows.overrides) {
      await insertRow(tx, "PreRetirementAccountOverride", o as unknown as Record<string, unknown>);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
