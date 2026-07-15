// Pure data-shaping for the Pre-retirement Snapshot — the single source of
// truth shared by the on-screen Snapshot view (src/ui/preretirement/
// SnapshotView.tsx) and the PDF export (src/export/snapshotPdf.ts), so the two
// can never drift. No DOM, no jsPDF: same inputs in → same plain object out.

import type { PersonId, Scenario } from "../model/types";
import type { InvestmentAccount, PreAccountKind } from "../model/preRetirementTypes";
import {
  PERSON_IDS,
  PRE_ACCOUNT_KINDS,
  PRE_ACCOUNT_KIND_LABELS,
} from "../model/preRetirementTypes";
import { monthLabel } from "../expenses/calc";
import { pct } from "../ui/format";

/** Hex colours mirroring the --nick / --tracy CSS custom properties in
 *  src/index.css (which aren't readable from a pure/Node context). */
export const PERSON_COLORS: Record<PersonId, string> = {
  nick: "#4da3ff",
  tracy: "#c98bff",
};

/** One row of a per-kind breakdown. `shareFraction` is the fraction (0..1) of
 *  the group total, or null when that total is 0 (rendered as "—"). */
export interface CategoryRow {
  kind: PreAccountKind;
  kindLabel: string;
  total: number;
  shareFraction: number | null;
}

/** One account's line: its value and share of the owner's total. */
export interface AccountRow {
  id: string;
  name: string;
  kind: PreAccountKind;
  kindLabel: string;
  value: number;
  shareFraction: number | null;
}

export interface PersonSummary {
  id: PersonId;
  name: string;
  colorHex: string;
  total: number;
  /** Fraction (0..1) of net worth, or null when net worth is 0. */
  shareFraction: number | null;
  categories: CategoryRow[];
  accounts: AccountRow[];
}

/** A plain, serialisable summary of the snapshot. */
export interface SnapshotSummary {
  title: string;
  coupleLabel: string;
  /** "8 July 2026" — the snapshot ("values as at") date. */
  asAtLabel: string;
  /** "15 July 2026" — the date the document was produced. */
  preparedLabel: string;
  dateIso: string;
  preparedIso: string;
  netWorth: number;
  people: PersonSummary[];
  /** Combined by-kind breakdown across both people. */
  bothCategories: CategoryRow[];
}

/** "2026-07-08" → "8 July 2026" (mirrors SnapshotView's dateLabel). */
function dateLabel(dateIso: string): string {
  return `${Number(dateIso.slice(8))} ${monthLabel(dateIso.slice(0, 7))}`;
}

/** Share of a whole as a fraction, or null when the whole is 0. */
function fraction(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Format a share fraction the same way on screen and in the PDF. */
export function shareLabel(f: number | null): string {
  return f === null ? "—" : pct(f, 1);
}

/** Per-kind totals for a set of accounts, ordered by PRE_ACCOUNT_KINDS. */
function categoriesFor(
  accounts: InvestmentAccount[],
  value: (id: string) => number,
): CategoryRow[] {
  const totals = new Map<PreAccountKind, number>();
  for (const a of accounts) totals.set(a.kind, (totals.get(a.kind) ?? 0) + value(a.id));
  const groupTotal = accounts.reduce((s, a) => s + value(a.id), 0);
  return PRE_ACCOUNT_KINDS.filter((k) => totals.has(k)).map((k) => ({
    kind: k,
    kindLabel: PRE_ACCOUNT_KIND_LABELS[k],
    total: totals.get(k)!,
    shareFraction: fraction(totals.get(k)!, groupTotal),
  }));
}

/**
 * Shape the snapshot balances into a plain summary. `balances` is the output of
 * `balancesAtDate`; `dateIso` is the snapshot date and `preparedIso` is today
 * (passed in, not read from the clock, so this stays pure and testable).
 */
export function buildSnapshotSummary(
  scenario: Scenario,
  accounts: InvestmentAccount[],
  balances: Record<string, number>,
  dateIso: string,
  preparedIso: string,
): SnapshotSummary {
  const value = (id: string) => balances[id] ?? 0;
  const personAccounts = (p: PersonId) => accounts.filter((a) => a.owner === p);
  const personTotal = (p: PersonId) => personAccounts(p).reduce((s, a) => s + value(a.id), 0);
  const netWorth = PERSON_IDS.reduce((s, p) => s + personTotal(p), 0);

  const people: PersonSummary[] = PERSON_IDS.map((p) => {
    const accts = personAccounts(p);
    const total = personTotal(p);
    return {
      id: p,
      name: scenario.people[p].name,
      colorHex: PERSON_COLORS[p],
      total,
      shareFraction: fraction(total, netWorth),
      categories: categoriesFor(accts, value),
      accounts: accts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        kindLabel: PRE_ACCOUNT_KIND_LABELS[a.kind],
        value: value(a.id),
        shareFraction: fraction(value(a.id), total),
      })),
    };
  });

  return {
    title: "Investment Snapshot",
    coupleLabel: PERSON_IDS.map((p) => scenario.people[p].name).join(" & "),
    asAtLabel: dateLabel(dateIso),
    preparedLabel: dateLabel(preparedIso),
    dateIso,
    preparedIso,
    netWorth,
    people,
    bothCategories: categoriesFor(accounts, value),
  };
}
