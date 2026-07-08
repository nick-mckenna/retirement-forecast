// The pre-retirement (accumulation) projection engine. Pure and deterministic,
// like simulate(): same inputs in → same result out. No store or I/O access.
//
// It walks every account in the registry month by month from the opening
// month to `endMonth`, applying growth first (like the retirement engine)
// and then the net flows tagged on that month's expense lines: a tagged
// expense line is a contribution INTO the account, a tagged income line is a
// withdrawal FROM it into the joint account. Each account grows at the rate
// for its kind (from the scenario's Rates via ratesForKinds).
//
// Flows use the line's expected `amount`, never `paid`: balance overrides
// (actual balance at the end of a recorded day, or of the whole month) are
// the single actuals-anchoring mechanism — an override replaces the computed
// balance at that point and the following months compound from it. For a
// mid-month record the rest of that month's growth is pro-rated by calendar
// days, and contributions due after the recorded day are still added;
// everything due on or before it (and undated lines, and tagged income —
// which has no due day) is assumed to be inside the recorded balance.

import type { Rates } from "../model/types";
import type { ExpenseMonth } from "../model/expenseTypes";
import type {
  BalanceOverride,
  InvestmentAccount,
  PreAccountKind,
  PreRetirementData,
} from "../model/preRetirementTypes";
import { annualToMonthly } from "../model/rates";
import { daysInMonth, monthKeysBetween, monthLabel } from "../expenses/calc";

export interface AccountMonthCell {
  /** Balance at the start of the month (= previous month's end). */
  start: number;
  /** start × monthly rate, applied before the month's flows. For a recorded
   *  month, only the growth applied after the anchor (pro-rated by days). */
  growth: number;
  /** Σ tagged expense-line amounts this month (money into the account). For a
   *  recorded month, only the contributions due after the recorded day. */
  contributions: number;
  /** Σ tagged income-line amounts this month (money out, into the joint
   *  account). 0 for a recorded month — income lines carry no due day, so
   *  they are assumed to be inside the recorded balance. */
  withdrawals: number;
  /** start + growth + contributions − withdrawals; for a recorded month,
   *  recorded.value + growth + contributions instead. */
  end: number;
  /** The actual-balance record anchoring this month, or null. `day` is as
   *  entered (null = end of month). Always: end = (recorded?.value ?? start)
   *  + growth + contributions − withdrawals. */
  recorded: { day: number | null; value: number } | null;
}

export interface ProjectionMonth {
  /** "yyyy-mm". */
  key: string;
  /** Keyed by account id (every registry account has a cell every month). */
  byAccount: Record<string, AccountMonthCell>;
  /** Cost basis at the month end, per GIA account id (for the CGT handoff). */
  basis: Record<string, number>;
  /** Σ end balances across all accounts. */
  total: number;
}

export interface PreRetirementResult {
  /** Chronological, openingMonth .. endMonth inclusive; empty if endMonth < openingMonth. */
  months: ProjectionMonth[];
  warnings: string[];
  /** Month keys in [openingMonth, endMonth] with no ExpenseMonth record (zero flows assumed). */
  missingMonthKeys: string[];
  /** accountId strings on tagged lines that match no registry account (treated as untagged). */
  unknownAccountIds: string[];
}

/** Annual growth rate per account kind, derived from a scenario's Rates. */
export type KindRates = Record<PreAccountKind, number>;

export function ratesForKinds(rates: Rates): KindRates {
  return {
    isa: rates.investmentGrowth,
    pension: rates.investmentGrowth,
    gia: rates.investmentGrowth,
    savings: rates.savingsInterest,
    premiumBonds: rates.savingsInterest,
    gilts: rates.giltCoupon,
  };
}

export interface MonthFlows {
  contributions: number;
  withdrawals: number;
  /** Each tagged expense line's due day (null = undated) and amount, so a
   *  mid-month balance record can tell which contributions it already contains. */
  contributionsByDay: { day: number | null; amount: number }[];
}

/** Net tagged flows per month per account id, from the lines' expected `amount`.
 *  Tags that match no registry account are reported, not applied. */
export function monthlyFlows(
  months: ExpenseMonth[],
  accounts: InvestmentAccount[],
): { flows: Map<string, Map<string, MonthFlows>>; unknownAccountIds: string[] } {
  const known = new Set(accounts.map((a) => a.id));
  const flows = new Map<string, Map<string, MonthFlows>>();
  const unknown = new Set<string>();
  const get = (monthKey: string, accountId: string): MonthFlows | null => {
    if (!known.has(accountId)) {
      unknown.add(accountId);
      return null;
    }
    const byAccount = flows.get(monthKey) ?? new Map<string, MonthFlows>();
    let f = byAccount.get(accountId);
    if (!f) {
      f = { contributions: 0, withdrawals: 0, contributionsByDay: [] };
      byAccount.set(accountId, f);
    }
    flows.set(monthKey, byAccount);
    return f;
  };
  for (const m of months) {
    for (const e of m.expenses) {
      if (e.accountId == null) continue;
      const f = get(m.key, e.accountId);
      if (f) {
        f.contributions += e.amount;
        f.contributionsByDay.push({ day: e.day, amount: e.amount });
      }
    }
    for (const inc of m.income) {
      if (inc.accountId == null) continue;
      const f = get(m.key, inc.accountId);
      if (f) f.withdrawals += inc.amount;
    }
  }
  return { flows, unknownAccountIds: [...unknown].sort() };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The heart of the module: project every registry account from the opening
 *  month to `endMonth` (inclusive) using the given per-kind annual growth rates. */
export function projectAccounts(
  data: PreRetirementData,
  expenseMonths: ExpenseMonth[],
  rates: KindRates,
  endMonth: string,
): PreRetirementResult {
  const warnings: string[] = [];

  // Guard against duplicate ids (possible only via hand-edited backups).
  const accounts: InvestmentAccount[] = [];
  const seen = new Set<string>();
  for (const a of data.accounts) {
    if (seen.has(a.id)) {
      warnings.push(`Duplicate account id "${a.id}" — ignoring "${a.name}".`);
      continue;
    }
    seen.add(a.id);
    accounts.push(a);
  }

  const { flows, unknownAccountIds } = monthlyFlows(expenseMonths, accounts);
  if (unknownAccountIds.length > 0) {
    warnings.push(
      `Expense lines are tagged to unknown/deleted account(s), treated as untagged: ${unknownAccountIds.join(", ")}.`,
    );
  }

  if (endMonth < data.openingMonth) {
    return { months: [], warnings, missingMonthKeys: [], unknownAccountIds };
  }

  // Tagged flows before the opening month are already inside the opening
  // balances — counting them again would double-count.
  const earlyFlowMonths = [...flows.keys()].filter((k) => k < data.openingMonth).sort();
  if (earlyFlowMonths.length > 0) {
    warnings.push(
      `Tagged amounts in ${earlyFlowMonths.map(monthLabel).join(", ")} fall before the opening month ` +
        `(${monthLabel(data.openingMonth)}) and are ignored — they are already part of the opening balances.`,
    );
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Latest record per account per month anchors the projection (a null day
  // means end of month, so it sorts after every dated record); earlier
  // same-month records are history and irrelevant to the month's end balance.
  const overrideMap = new Map<string, { day: number | null; value: number }>();
  const effectiveDay = (day: number | null | undefined) => day ?? 32;
  for (const o of data.overrides) {
    const acc = byId.get(o.accountId);
    if (!acc) {
      warnings.push(`Balance override for unknown account "${o.accountId}" in ${monthLabel(o.monthKey)} is ignored.`);
      continue;
    }
    if (o.monthKey < data.openingMonth) {
      warnings.push(
        `Balance override for ${acc.name} in ${monthLabel(o.monthKey)} falls before the opening month and is ignored.`,
      );
      continue;
    }
    const k = `${o.accountId}:${o.monthKey}`;
    const prev = overrideMap.get(k);
    if (!prev || effectiveDay(o.day) >= effectiveDay(prev.day)) {
      overrideMap.set(k, { day: o.day ?? null, value: o.value });
    }
  }

  const trackedKeys = new Set(expenseMonths.map((m) => m.key));
  const range = monthKeysBetween(data.openingMonth, endMonth);
  const missingMonthKeys = range.filter((k) => !trackedKeys.has(k));
  if (missingMonthKeys.length > 0) {
    const first = monthLabel(missingMonthKeys[0]);
    const last = monthLabel(missingMonthKeys[missingMonthKeys.length - 1]);
    warnings.push(
      `${missingMonthKeys.length} month(s) in the forecast range have no expense record ` +
        `(${missingMonthKeys.length === 1 ? first : `${first} … ${last}`}) — assumed zero contributions.`,
    );
  }

  const balances = new Map<string, number>();
  const basis = new Map<string, number>();
  for (const a of accounts) {
    balances.set(a.id, a.openingBalance);
    if (a.kind === "gia") {
      basis.set(a.id, a.openingBalance * (1 - clamp01(a.openingGainFraction ?? 0)));
    }
  }

  const months: ProjectionMonth[] = [];
  for (const key of range) {
    const monthFlows = flows.get(key);
    const byAccount: Record<string, AccountMonthCell> = {};
    let total = 0;
    for (const a of accounts) {
      const start = balances.get(a.id)!;
      const monthlyRate = annualToMonthly(rates[a.kind]);
      const monthGrowth = start * monthlyRate;
      const f = monthFlows?.get(a.id);
      const monthContributions = f?.contributions ?? 0;
      const monthWithdrawals = f?.withdrawals ?? 0;
      const record = overrideMap.get(`${a.id}:${key}`);

      let cell: AccountMonthCell;
      if (record == null) {
        cell = {
          start,
          growth: monthGrowth,
          contributions: monthContributions,
          withdrawals: monthWithdrawals,
          end: start + monthGrowth + monthContributions - monthWithdrawals,
          recorded: null,
        };
      } else {
        // The recorded value already contains everything up to the end of its
        // day: actual growth, every flow due on or before it, undated lines
        // and tagged income. Left for the rest of the month: growth pro-rated
        // by calendar days, plus contributions due later.
        const dim = daysInMonth(key);
        const day = Math.min(Math.max(record.day ?? dim, 1), dim);
        const growth = record.value * (Math.pow(1 + monthlyRate, (dim - day) / dim) - 1);
        const contributions = (f?.contributionsByDay ?? [])
          .filter((c) => (c.day ?? 1) > day)
          .reduce((s, c) => s + c.amount, 0);
        cell = {
          start,
          growth,
          contributions,
          withdrawals: 0,
          end: record.value + growth + contributions,
          recorded: record,
        };
      }

      if (a.kind === "gia") {
        // Basis grows with the month's full contributions (they are real
        // money in whether or not a record absorbs them); withdrawals take
        // basis out proportionally to the value sold. Growth and recorded
        // balances change the embedded gain, never the basis.
        let b = basis.get(a.id)! + monthContributions;
        const valueBeforeWithdrawal = start + monthGrowth + monthContributions;
        if (monthWithdrawals > 0 && valueBeforeWithdrawal > 0) {
          b -= monthWithdrawals * (b / valueBeforeWithdrawal);
        }
        basis.set(a.id, Math.max(0, b));
      }

      byAccount[a.id] = cell;
      balances.set(a.id, cell.end);
      total += cell.end;
    }
    months.push({ key, byAccount, basis: Object.fromEntries(basis), total });
  }

  return { months, warnings, missingMonthKeys, unknownAccountIds };
}

/** The account's most recent actual-balance record — the one the Accounts UI
 *  shows and edits — using the engine's ordering (null day = end of month,
 *  later entries win ties). Null when the account has none. */
export function latestOverride(data: PreRetirementData, accountId: string): BalanceOverride | null {
  let best: BalanceOverride | null = null;
  let bestKey = "";
  for (const o of data.overrides) {
    if (o.accountId !== accountId) continue;
    const key = `${o.monthKey}:${String(o.day ?? 32).padStart(2, "0")}`;
    if (!best || key >= bestKey) {
      best = o;
      bestKey = key;
    }
  }
  return best;
}

/** End-of-day balances per account id at an ISO date ("yyyy-mm-dd"), using
 *  the same intra-month model as recorded balances: growth compounds by the
 *  calendar-day fraction of the monthly rate, a contribution arrives at the
 *  end of its due day (undated lines and tagged income at the start of the
 *  month), and the latest record on or before the date re-anchors the
 *  balance. At a month's last day this equals that month's cell end exactly.
 *  Clamped to the projection range: before the first month → the opening
 *  (start) balances; after the last → the final month's end balances. Empty
 *  when the projection is empty. */
export function balancesAtDate(
  result: PreRetirementResult,
  data: PreRetirementData,
  expenseMonths: ExpenseMonth[],
  rates: KindRates,
  dateIso: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  if (!first || !last) return out;
  const monthKey = dateIso.slice(0, 7);
  if (monthKey < first.key) {
    for (const [id, cell] of Object.entries(first.byAccount)) out[id] = cell.start;
    return out;
  }
  if (monthKey > last.key) {
    for (const [id, cell] of Object.entries(last.byAccount)) out[id] = cell.end;
    return out;
  }
  const month = result.months.find((m) => m.key === monthKey);
  if (!month) return out; // unreachable: every month in the range is emitted
  const dim = daysInMonth(monthKey);
  const day = Math.min(Math.max(Number(dateIso.slice(8, 10)) || dim, 1), dim);
  const clampDay = (d: number | null | undefined) => Math.min(Math.max(d ?? dim, 1), dim);
  const { flows } = monthlyFlows(
    expenseMonths.filter((m) => m.key === monthKey),
    data.accounts,
  );
  const monthFlows = flows.get(monthKey);
  for (const a of data.accounts) {
    const cell = month.byAccount[a.id];
    if (!cell || a.id in out) continue; // duplicate ids: first one wins, like the engine
    // Latest record on or before the date, with the engine's tie-breaking
    // (null day = end of month, later entries win ties).
    let anchor: { eff: number; day: number; value: number } | null = null;
    for (const o of data.overrides) {
      if (o.accountId !== a.id || o.monthKey !== monthKey) continue;
      const oDay = clampDay(o.day);
      if (oDay > day) continue;
      const eff = o.day ?? 32;
      if (!anchor || eff >= anchor.eff) anchor = { eff, day: oDay, value: o.value };
    }
    const from = anchor?.day ?? 0;
    const base = anchor?.value ?? cell.start;
    const monthlyRate = annualToMonthly(rates[a.kind]);
    const growth = base * (Math.pow(1 + monthlyRate, (day - from) / dim) - 1);
    const f = monthFlows?.get(a.id);
    const contributions = (f?.contributionsByDay ?? [])
      .filter((c) => {
        const d = c.day ?? 1;
        return d > from && d <= day;
      })
      .reduce((s, c) => s + c.amount, 0);
    // Income lines carry no due day: they move at the start of the month, so
    // they are gone by any sampled day and inside any anchor.
    const withdrawals = anchor ? 0 : (f?.withdrawals ?? 0);
    out[a.id] = base + growth + contributions - withdrawals;
  }
  return out;
}
