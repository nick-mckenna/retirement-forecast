import type { PersonId, Scenario } from "./types";
import type { ExpenseData } from "./expenseTypes";
import type { InvestmentAccount, PreAccountKind, PreRetirementData } from "./preRetirementTypes";
import {
  defaultPreRetirementData,
  emptyPreRetirementData,
  PRE_ACCOUNT_KIND_LABELS,
} from "./preRetirementTypes";
import { defaultScenario } from "./defaults";

/**
 * Backfill fields added in later versions so older saved scenarios (from the
 * database, localStorage or an imported JSON backup) keep working.
 */
export function migrateScenario(s: Scenario): Scenario {
  return {
    ...s,
    linkPreRetirement: s.linkPreRetirement ?? false,
    income: { ...s.income, mode: s.income.mode ?? "fixed", swrRate: s.income.swrRate ?? defaultScenario().income.swrRate },
    strategy: { ...s.strategy, taxMode: s.strategy.taxMode ?? "heuristic" },
    taxParams: s.taxParams ?? [],
    overrides: s.overrides ?? [],
    purchases: s.purchases ?? [],
  };
}

/** Same idea for the expense tracker: tolerate data saved by older versions. */
export function migrateExpenseData(d: ExpenseData): ExpenseData {
  return {
    templates: {
      expenses: (d.templates?.expenses ?? []).map((t) => ({ ...t, accountId: t.accountId ?? null })),
      income: (d.templates?.income ?? []).map((t) => ({ ...t, accountId: t.accountId ?? null })),
    },
    months: (d.months ?? []).map((m) => ({
      ...m,
      currentBalance: m.currentBalance ?? null,
      expenses: (m.expenses ?? []).map((e) => ({ ...e, accountId: e.accountId ?? null })),
      income: (m.income ?? []).map((i) => ({ ...i, accountId: i.accountId ?? null })),
    })),
  };
}

/** The first pre-retirement version modelled fixed person × kind pots rather
 *  than named accounts. Its shape, for the legacy-save upgrade below. */
interface LegacyPreRetirementData {
  openingMonth?: string;
  pots?: Record<PersonId, Partial<Record<PreAccountKind, number>>>;
  giaGainFraction?: Record<PersonId, number>;
  overrides?: { person: PersonId; kind: PreAccountKind; monthKey: string; value: number }[];
}

/** Convert a legacy pot-based save into registry accounts. Account ids reuse
 *  the old composite tag form ("nick:isa") so any expense lines tagged under
 *  the pot model keep resolving. */
function accountsFromLegacyPots(d: LegacyPreRetirementData): {
  accounts: InvestmentAccount[];
  overrides: PreRetirementData["overrides"];
} {
  const label = (p: PersonId, k: PreAccountKind) =>
    `${p.charAt(0).toUpperCase()}${p.slice(1)} ${PRE_ACCOUNT_KIND_LABELS[k]}`;
  const accounts = new Map<string, InvestmentAccount>();
  const ensure = (person: PersonId, kind: PreAccountKind): InvestmentAccount => {
    const id = `${person}:${kind}`;
    let acc = accounts.get(id);
    if (!acc) {
      acc = {
        id,
        name: label(person, kind),
        owner: person,
        kind,
        openingBalance: 0,
        openingGainFraction: kind === "gia" ? (d.giaGainFraction?.[person] ?? 0) : null,
      };
      accounts.set(id, acc);
    }
    return acc;
  };
  for (const person of ["nick", "tracy"] as PersonId[]) {
    const pots = d.pots?.[person] ?? {};
    for (const [kind, balance] of Object.entries(pots) as [PreAccountKind, number][]) {
      if (balance !== 0) ensure(person, kind).openingBalance = balance;
    }
  }
  const overrides = (d.overrides ?? []).map((o) => {
    ensure(o.person, o.kind);
    return { accountId: `${o.person}:${o.kind}`, monthKey: o.monthKey, day: null, value: o.value };
  });
  return { accounts: [...accounts.values()], overrides };
}

/** And for the pre-retirement module: tolerate data saved by older versions
 *  (including the original fixed-pots shape). */
export function migratePreRetirementData(d: PreRetirementData): PreRetirementData {
  const empty = emptyPreRetirementData();
  const legacy = d as unknown as LegacyPreRetirementData;
  if (!Array.isArray(d.accounts) && legacy.pots) {
    const upgraded = accountsFromLegacyPots(legacy);
    // An untouched legacy save (all-zero pots, no overrides) means the pots
    // module was never really used — give them the fresh-install registry.
    if (upgraded.accounts.length === 0 && upgraded.overrides.length === 0) {
      return { ...defaultPreRetirementData(), openingMonth: d.openingMonth ?? empty.openingMonth };
    }
    return {
      openingMonth: d.openingMonth ?? empty.openingMonth,
      accounts: upgraded.accounts,
      overrides: upgraded.overrides,
    };
  }
  return {
    openingMonth: d.openingMonth ?? empty.openingMonth,
    accounts: (d.accounts ?? []).map((a) => ({
      ...a,
      openingBalance: a.openingBalance ?? 0,
      openingGainFraction: a.openingGainFraction ?? null,
    })),
    overrides: (d.overrides ?? []).map((o) => ({ ...o, day: o.day ?? null })),
  };
}
