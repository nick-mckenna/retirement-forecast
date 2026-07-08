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
// (actual balance at the END of a month) are the single actuals-anchoring
// mechanism — an override replaces the computed end balance and the following
// months compound from it.

import type { Rates } from "../model/types";
import type { ExpenseMonth } from "../model/expenseTypes";
import type {
  InvestmentAccount,
  PreAccountKind,
  PreRetirementData,
} from "../model/preRetirementTypes";
import { annualToMonthly } from "../model/rates";
import { monthKeysBetween, monthLabel } from "../expenses/calc";

export interface AccountMonthCell {
  /** Balance at the start of the month (= previous month's end). */
  start: number;
  /** start × monthly rate, applied before the month's flows. */
  growth: number;
  /** Σ tagged expense-line amounts this month (money into the account). */
  contributions: number;
  /** Σ tagged income-line amounts this month (money out, into the joint account). */
  withdrawals: number;
  /** start + growth + contributions − withdrawals, then replaced by an override if present. */
  end: number;
  overridden: boolean;
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
  const add = (monthKey: string, accountId: string, field: keyof MonthFlows, amount: number) => {
    if (!known.has(accountId)) {
      unknown.add(accountId);
      return;
    }
    const byAccount = flows.get(monthKey) ?? new Map<string, MonthFlows>();
    const f = byAccount.get(accountId) ?? { contributions: 0, withdrawals: 0 };
    f[field] += amount;
    byAccount.set(accountId, f);
    flows.set(monthKey, byAccount);
  };
  for (const m of months) {
    for (const e of m.expenses) if (e.accountId != null) add(m.key, e.accountId, "contributions", e.amount);
    for (const inc of m.income) if (inc.accountId != null) add(m.key, inc.accountId, "withdrawals", inc.amount);
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
  const overrideMap = new Map<string, number>();
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
    overrideMap.set(`${o.accountId}:${o.monthKey}`, o.value);
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
      const growth = start * annualToMonthly(rates[a.kind]);
      const f = monthFlows?.get(a.id);
      const contributions = f?.contributions ?? 0;
      const withdrawals = f?.withdrawals ?? 0;
      let end = start + growth + contributions - withdrawals;
      const override = overrideMap.get(`${a.id}:${key}`);
      const overridden = override != null;
      if (override != null) end = override;

      if (a.kind === "gia") {
        // Basis grows with contributions; withdrawals take basis out
        // proportionally to the value sold. Growth and overrides change
        // the embedded gain, never the basis.
        let b = basis.get(a.id)! + contributions;
        const valueBeforeWithdrawal = start + growth + contributions;
        if (withdrawals > 0 && valueBeforeWithdrawal > 0) {
          b -= withdrawals * (b / valueBeforeWithdrawal);
        }
        basis.set(a.id, Math.max(0, b));
      }

      byAccount[a.id] = { start, growth, contributions, withdrawals, end, overridden };
      balances.set(a.id, end);
      total += end;
    }
    months.push({ key, byAccount, basis: Object.fromEntries(basis), total });
  }

  return { months, warnings, missingMonthKeys, unknownAccountIds };
}

/** End balances per account id at `monthKey`, clamped to the projection range:
 *  before the first month → the opening (start) balances; after the last →
 *  the final month's end balances. Empty when the projection is empty. */
export function balancesAt(result: PreRetirementResult, monthKey: string): Record<string, number> {
  const out: Record<string, number> = {};
  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  if (!first || !last) return out;
  if (monthKey < first.key) {
    for (const [id, cell] of Object.entries(first.byAccount)) out[id] = cell.start;
    return out;
  }
  const month = monthKey > last.key ? last : result.months.find((m) => m.key === monthKey);
  const source = month ?? last;
  for (const [id, cell] of Object.entries(source.byAccount)) out[id] = cell.end;
  return out;
}
