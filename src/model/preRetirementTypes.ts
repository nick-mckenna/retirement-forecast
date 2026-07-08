// Domain model for the pre-retirement (accumulation) forecast — the third
// module alongside the retirement forecast and the monthly expense tracker.
//
// Accounts are a user-editable registry of the couple's real accounts
// ("Nick ISA", "Tracy Premium Bonds", …). Each account has an owner
// and a kind; the kind decides its growth rate (via the scenario's Rates) and
// which retirement pot it folds into at handoff (savings + premiumBonds merge
// into the scenario's savings pot, everything else maps 1:1). Expense/income
// lines are tagged with an account's id, the projection engine
// (src/preretirement/project.ts) grows each account month by month, and a
// linked retirement scenario reads its starting balances from the projection.
//
// Like the other modules, everything is plain JSON (no Dates, no classes):
// month keys are "yyyy-mm", monetary values are GBP.

import type { PersonId } from "./types";

/** The grouping vocabulary: the retirement forecaster's pots + premiumBonds. */
export type PreAccountKind = "isa" | "pension" | "gia" | "savings" | "premiumBonds" | "gilts";

export const PRE_ACCOUNT_KINDS: PreAccountKind[] = [
  "isa",
  "pension",
  "gia",
  "savings",
  "premiumBonds",
  "gilts",
];

export const PRE_ACCOUNT_KIND_LABELS: Record<PreAccountKind, string> = {
  isa: "ISA",
  pension: "Pension",
  gia: "GIA",
  savings: "Savings",
  premiumBonds: "Premium Bonds",
  gilts: "Gilts",
};

export const PERSON_IDS: PersonId[] = ["nick", "tracy"];

/** A real, named account (e.g. "Nick ISA"). Global, like the expense
 *  tracker: scenario duplicate/delete must never fork or destroy the registry. */
export interface InvestmentAccount {
  /** Stable id referenced by expense-line tags and balance overrides. */
  id: string;
  name: string;
  owner: PersonId;
  kind: PreAccountKind;
  /** Balance at the start of PreRetirementData.openingMonth. */
  openingBalance: number;
  /** GIA accounts only: embedded capital-gain fraction (0..1) of the opening
   *  balance, seeding the cost basis for the CGT handoff; null for other kinds. */
  openingGainFraction: number | null;
}

/** Re-anchors one account's projection: `value` is the account's actual
 *  balance at the END of `day` in `monthKey` (or at the end of the whole
 *  month when `day` is null). This is how actual growth (including losses)
 *  is recorded — expense-line flows deliberately use expected amounts, not
 *  `paid`, so overrides are the single actuals-anchoring mechanism. When a
 *  month has several records, the latest-day one anchors the projection;
 *  earlier ones are kept as history. */
export interface BalanceOverride {
  accountId: string;
  monthKey: string;
  /** 1-based day of the month the balance was taken at the end of; null =
   *  the end of the month. Days past the month's length clamp to its last day. */
  day: number | null;
  value: number;
}

/** Root object for the pre-retirement module. Global, not per-scenario. */
export interface PreRetirementData {
  /** "yyyy-mm" — every account's opening balance is as of the START of this month. */
  openingMonth: string;
  accounts: InvestmentAccount[];
  overrides: BalanceOverride[];
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** A truly empty document — what the server reports before anything is saved. */
export function emptyPreRetirementData(): PreRetirementData {
  return { openingMonth: currentMonthKey(), accounts: [], overrides: [] };
}

/** Fresh install: a generic sample registry — one account per person × kind,
 *  zero opening balances. Rename/extend the accounts to match your own.
 *  Deliberately synthetic: real account details (names, providers, balances)
 *  live only in the local database, never in committed code. */
export function defaultPreRetirementData(): PreRetirementData {
  const a = (
    id: string,
    name: string,
    owner: PersonId,
    kind: PreAccountKind,
  ): InvestmentAccount => ({
    id,
    name,
    owner,
    kind,
    openingBalance: 0,
    openingGainFraction: kind === "gia" ? 0 : null,
  });
  return {
    openingMonth: currentMonthKey(),
    accounts: [
      a("nick-isa", "Nick ISA", "nick", "isa"),
      a("nick-pension", "Nick Pension", "nick", "pension"),
      a("nick-gia", "Nick General Investment", "nick", "gia"),
      a("nick-savings", "Nick Savings", "nick", "savings"),
      a("nick-premium-bonds", "Nick Premium Bonds", "nick", "premiumBonds"),
      a("nick-gilts", "Nick Gilts", "nick", "gilts"),
      a("tracy-isa", "Tracy ISA", "tracy", "isa"),
      a("tracy-pension", "Tracy Pension", "tracy", "pension"),
      a("tracy-gia", "Tracy General Investment", "tracy", "gia"),
      a("tracy-savings", "Tracy Savings", "tracy", "savings"),
      a("tracy-premium-bonds", "Tracy Premium Bonds", "tracy", "premiumBonds"),
      a("tracy-gilts", "Tracy Gilts", "tracy", "gilts"),
    ],
    overrides: [],
  };
}
