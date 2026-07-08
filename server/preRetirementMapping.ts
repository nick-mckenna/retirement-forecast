// Pure mapping between the pre-retirement domain object and the normalized
// SQL rows, mirroring expenseMapping.ts. No DB or Node dependencies so it can
// be unit-tested alongside the projection engine.
//
// Every user-editable pre-retirement field must appear here exactly once in
// each direction; the round-trip test in
// src/__tests__/preRetirementMapping.test.ts guards that.

import type { PersonId } from "../src/model/types";
import type {
  BalanceOverride,
  InvestmentAccount,
  PreAccountKind,
  PreRetirementData,
} from "../src/model/preRetirementTypes";

type SqlNum = number | string;

export interface PreRetirementStateRow {
  id: number;
  openingMonth: string;
}

export interface PreRetirementAccountRow {
  accountId: string;
  name: string;
  /** "owner" is an ODBC reserved word, hence the rename (like day ↔ dayOfMonth). */
  ownerId: string;
  kind: string;
  openingBalance: SqlNum;
  /** Embedded gain fraction; only meaningful for kind 'gia', null elsewhere. */
  gainFraction: SqlNum | null;
  sortOrder: number;
}

export interface PreRetirementOverrideRow {
  accountId: string;
  monthKey: string;
  value: SqlNum;
}

export interface PreRetirementRows {
  state: PreRetirementStateRow;
  accounts: PreRetirementAccountRow[];
  overrides: PreRetirementOverrideRow[];
}

function num(v: SqlNum): number {
  return typeof v === "number" ? v : Number(v);
}

function numOrNull(v: SqlNum | null | undefined): number | null {
  return v == null ? null : num(v);
}

export function preRetirementToRows(d: PreRetirementData): PreRetirementRows {
  return {
    state: { id: 1, openingMonth: d.openingMonth },
    accounts: d.accounts.map(
      (a, i): PreRetirementAccountRow => ({
        accountId: a.id,
        name: a.name,
        ownerId: a.owner,
        kind: a.kind,
        openingBalance: a.openingBalance,
        gainFraction: a.openingGainFraction,
        sortOrder: i,
      }),
    ),
    overrides: d.overrides.map(
      (o): PreRetirementOverrideRow => ({
        accountId: o.accountId,
        monthKey: o.monthKey,
        value: o.value,
      }),
    ),
  };
}

export function rowsToPreRetirement(r: PreRetirementRows): PreRetirementData {
  const accounts = [...r.accounts]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(
      (row): InvestmentAccount => ({
        id: row.accountId,
        name: row.name,
        owner: row.ownerId as PersonId,
        kind: row.kind as PreAccountKind,
        openingBalance: num(row.openingBalance),
        openingGainFraction: numOrNull(row.gainFraction),
      }),
    );
  const overrides = [...r.overrides]
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.monthKey.localeCompare(b.monthKey))
    .map(
      (row): BalanceOverride => ({
        accountId: row.accountId,
        monthKey: row.monthKey,
        value: num(row.value),
      }),
    );
  return { openingMonth: r.state.openingMonth, accounts, overrides };
}
