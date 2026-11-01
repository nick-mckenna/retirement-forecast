import type { PersonId, Scenario, TaxPolicy, TaxYearOverride } from "./types";
import type { ExpenseData } from "./expenseTypes";
import type { InvestmentAccount, PreAccountKind, PreRetirementData } from "./preRetirementTypes";
import {
  defaultPreRetirementData,
  emptyPreRetirementData,
  PRE_ACCOUNT_KIND_LABELS,
} from "./preRetirementTypes";
import { defaultScenario, SCHEMA_VERSION } from "./defaults";
import { DEFAULT_TAX_POLICY } from "../tax/taxParams";
import { firstModelledTaxYear, isIsoDate } from "../tax/taxYear";
import { statutoryStatePensionAge } from "../tax/statePension";

/**
 * Backfill fields added in later versions so older saved scenarios (from the
 * database, localStorage or an imported JSON backup) keep working. One-off shape
 * changes are gated on `schemaVersion`, so each runs exactly once.
 */
export function migrateScenario(s: Scenario): Scenario {
  const version = s.schemaVersion ?? 1;
  let taxPolicy: TaxPolicy;
  let taxParams: TaxYearOverride[];
  if (version < 2) {
    ({ taxPolicy, taxParams } = migrateTaxV1(s));
  } else {
    taxPolicy = {
      freezeUntilYear: s.taxPolicy?.freezeUntilYear ?? DEFAULT_TAX_POLICY.freezeUntilYear,
      indexation: s.taxPolicy?.indexation ?? DEFAULT_TAX_POLICY.indexation,
      uprating: s.taxPolicy?.uprating ?? DEFAULT_TAX_POLICY.uprating,
    };
    taxParams = s.taxParams ?? [];
  }
  // A cleared/garbled start date has no handoff month and used to hang the projection:
  // repair it to the day before the first modelled tax year.
  const startDate = isIsoDate(s.startDate) ? s.startDate : `${s.income.startYear}-04-05`;
  const person = (id: PersonId) => {
    const p = s.people[id];
    let statePensionAge = p.statePensionAge ?? null;
    // v3: State Pension age became an optional override (null = statutory). An old whole-year
    // age that is just the statutory age in whole years (e.g. 66 for someone due 66y 7m)
    // becomes statutory, so the legislated months apply.
    if (version < 3 && statePensionAge != null && isIsoDate(p.dob)) {
      if (Math.floor(statutoryStatePensionAge(p.dob)) === statePensionAge) statePensionAge = null;
    }
    return { ...p, statePensionAge, lumpSumAllowanceUsed: p.lumpSumAllowanceUsed ?? 0 };
  };
  return {
    ...s,
    startDate,
    linkPreRetirement: s.linkPreRetirement ?? false,
    people: { nick: person("nick"), tracy: person("tracy") },
    rates: { ...s.rates, statePensionGrowth: s.rates.statePensionGrowth ?? null },
    married: s.married ?? false,
    income: {
      ...s.income,
      mode: s.income.mode ?? "fixed",
      swrRate: s.income.swrRate ?? defaultScenario().income.swrRate,
      // Derived, not an independent input: the tax year the model's first day falls in.
      startYear: firstModelledTaxYear(startDate),
    },
    strategy: { ...s.strategy, taxMode: s.strategy.taxMode ?? "heuristic" },
    taxPolicy,
    taxParams,
    overrides: s.overrides ?? [],
    purchases: s.purchases ?? [],
    schemaVersion: SCHEMA_VERSION,
  };
}

// ---- v1 → v2: threshold policy + sparse tax-parameter edits --------------------------------

type LegacyParams = Record<(typeof LEGACY_FIELDS)[number], number>;

/** The v1 tax-parameter fields and their 2025/26 values, frozen here (not imported) so a v1
 *  save's stored rows can always be compared with what v1 itself would have projected. */
const LEGACY_BASE = {
  personalAllowance: 12570,
  paTaperThreshold: 100000,
  basicRateBand: 37700,
  higherRateBand: 87440,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  psaBasic: 1000,
  psaHigher: 500,
  savingsStartingRateBand: 5000,
  dividendAllowance: 500,
  dividendBasicRate: 0.0875,
  dividendHigherRate: 0.3375,
  dividendAdditionalRate: 0.3935,
  cgtAnnualExempt: 3000,
  cgtBasicRate: 0.18,
  cgtHigherRate: 0.24,
  isaAllowance: 20000,
} as const;
const LEGACY_FIELDS = Object.keys(LEGACY_BASE) as (keyof typeof LEGACY_BASE)[];
const LEGACY_UPRATED: (keyof typeof LEGACY_BASE)[] = [
  "personalAllowance",
  "basicRateBand",
  "higherRateBand",
  "psaBasic",
  "psaHigher",
  "savingsStartingRateBand",
  "dividendAllowance",
  "cgtAnnualExempt",
  "isaAllowance",
];

function legacyProjection(year: number, freezeUntilYear: number, uprating: number): LegacyParams {
  const p: LegacyParams = { ...LEGACY_BASE };
  const n = year - freezeUntilYear;
  if (n > 0 && uprating !== 0) {
    for (const f of LEGACY_UPRATED) p[f] = Math.round(LEGACY_BASE[f] * Math.pow(1 + uprating, n));
  }
  return p;
}

/**
 * v1 stored a policy of {freezeUntilYear, uprating} and *whole* rows for every edited year
 * (a snapshot of the projection at the time, plus the edit). The untouched v1 default
 * ({2031, 0}) becomes the new statutory default; any other policy is kept as "custom".
 * Each stored row keeps only the fields that differ from v1's own projection — the real
 * edits — so everything else now follows the projection; rows left empty are dropped.
 */
function migrateTaxV1(s: Scenario): { taxPolicy: TaxPolicy; taxParams: TaxYearOverride[] } {
  const freeze = s.taxPolicy?.freezeUntilYear ?? 2031;
  const uprating = s.taxPolicy?.uprating ?? 0;
  const taxPolicy: TaxPolicy =
    freeze === 2031 && uprating === 0
      ? { ...DEFAULT_TAX_POLICY }
      : { freezeUntilYear: freeze, indexation: "custom", uprating };
  const taxParams: TaxYearOverride[] = [];
  for (const row of s.taxParams ?? []) {
    const projected = legacyProjection(row.year, freeze, uprating);
    const sparse: TaxYearOverride = { year: row.year };
    for (const f of LEGACY_FIELDS) {
      const v = row[f];
      if (typeof v === "number" && Math.abs(v - projected[f]) > 1e-9) sparse[f] = v;
    }
    if (Object.keys(sparse).length > 1) taxParams.push(sparse);
  }
  return { taxPolicy, taxParams };
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
      // templateId must be a real null, not undefined: it is what tells a one-off
      // line from one snapshotted off a standard item, and an orphan (a line whose
      // template has since gone) from a one-off that should be kept.
      expenses: (m.expenses ?? []).map((e) => ({
        ...e,
        templateId: e.templateId ?? null,
        accountId: e.accountId ?? null,
      })),
      income: (m.income ?? []).map((i) => ({
        ...i,
        templateId: i.templateId ?? null,
        accountId: i.accountId ?? null,
      })),
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
