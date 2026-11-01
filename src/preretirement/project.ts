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
import type { ExpenseMonth, ExpenseTemplates } from "../model/expenseTypes";
import type {
  BalanceOverride,
  InvestmentAccount,
  PreAccountKind,
  PreRetirementData,
} from "../model/preRetirementTypes";
import { annualToMonthly } from "../model/rates";
import { clampDay, createMonthFromTemplates, daysInMonth, monthKeysBetween, monthLabel } from "../expenses/calc";
import { PREMIUM_BOND_LIMIT, RELIEF_AT_SOURCE_GROSS_UP } from "../tax/allowanceLimits";
import { buildPricing, type GiltPricing } from "../gilts/pricing";
import { addDays, monthEnd } from "../gilts/schedule";
import { giltFlowsBetween, lotCost, lotsByAccount, lotsValue } from "./giltAccounts";

/** One account's growth, given what it holds once the period's money has moved (`held`):
 *  Premium Bond prizes are only reinvested up to the holding limit (NS&I pays the rest out, to
 *  wherever the holding pays — outside the registry), so a holding at the limit stops growing.
 *  Money paid in above the limit is not trimmed — allowanceWarnings flags it. Other kinds grow
 *  freely. */
function cappedGrowth(a: InvestmentAccount, held: number, growth: number): number {
  return a.kind === "premiumBonds" ? Math.min(growth, Math.max(0, PREMIUM_BOND_LIMIT - held)) : growth;
}

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
  /** Cash at the month end, per gilt account holding real gilts (the rest of its balance is
   *  the gilts at market value). */
  giltCash: Record<string, number>;
  /** Σ end balances across all accounts. */
  total: number;
}

export interface PreRetirementResult {
  /** The registry accounts actually projected (duplicate ids dropped, first one wins) — iterate
   *  these, not the raw registry, when reading cells. */
  accounts: InvestmentAccount[];
  /** Chronological, openingMonth .. endMonth inclusive; empty if endMonth < openingMonth. */
  months: ProjectionMonth[];
  warnings: string[];
  /** Month keys in [openingMonth, endMonth] with no ExpenseMonth record. */
  missingMonthKeys: string[];
  /** What the projection assumed for those months: a snapshot of the standard items each (so
   *  their tagged lines still contribute), or empty when no templates were given (zero flows). */
  assumedMonths: ExpenseMonth[];
  /** accountId strings on tagged lines that match no registry account (treated as untagged). */
  unknownAccountIds: string[];
  /** How real gilts were priced (par when no market was given) — `sampleAtDate` reuses it. */
  pricing: GiltPricing;
}

/** Annual growth rate per account kind, derived from a scenario's Rates. */
export type KindRates = Record<PreAccountKind, number>;

export function ratesForKinds(rates: Rates): KindRates {
  return {
    isa: rates.investmentGrowth,
    pension: rates.investmentGrowth,
    gia: rates.investmentGrowth,
    savings: rates.savingsInterest,
    premiumBonds: rates.premiumBondRate,
    // A gilt account held as a single figure stays at nominal value (coupons recorded as
    // untagged income). One holding real gilts is valued at market prices instead, its coupons
    // and redemptions modelled (giltAccounts.ts) - its cash earns nothing.
    gilts: 0,
  };
}

export interface MonthFlows {
  contributions: number;
  withdrawals: number;
  /** Each tagged expense line's due day (null = undated) and amount, so a
   *  mid-month balance record can tell which contributions it already contains. */
  contributionsByDay: { day: number | null; amount: number }[];
}

/** Net flows per month per account id: tagged lines at their expected `amount` (a pension
 *  contribution into a relief-at-source account is grossed up by basic-rate relief), plus —
 *  for each month in `outsideKeys` — every account's outside contribution, due on the
 *  month's last day. Tags that match no registry account are reported, not applied. */
export function monthlyFlows(
  months: ExpenseMonth[],
  accounts: InvestmentAccount[],
  outsideKeys: string[] = [],
): { flows: Map<string, Map<string, MonthFlows>>; unknownAccountIds: string[] } {
  const known = new Set(accounts.map((a) => a.id));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const grossUp = (id: string) => {
    const a = byId.get(id);
    return a?.kind === "pension" && a.reliefAtSource ? RELIEF_AT_SOURCE_GROSS_UP : 1;
  };
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
        const amount = e.amount * grossUp(e.accountId);
        f.contributions += amount;
        // A due day past the month's length (e.g. the 30th in February) falls on its last
        // day — otherwise it would sort after an end-of-month record and be counted twice.
        f.contributionsByDay.push({ day: e.day == null ? null : clampDay(e.day, m.key), amount });
      }
    }
    for (const inc of m.income) {
      if (inc.accountId == null) continue;
      const f = get(m.key, inc.accountId);
      if (f) f.withdrawals += inc.amount;
    }
  }
  for (const key of outsideKeys) {
    for (const a of accounts) {
      if (!(a.externalMonthlyContribution > 0)) continue;
      const f = get(key, a.id)!;
      f.contributions += a.externalMonthlyContribution;
      f.contributionsByDay.push({ day: daysInMonth(key), amount: a.externalMonthlyContribution });
    }
  }
  return { flows, unknownAccountIds: [...unknown].sort() };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The registry with duplicate ids dropped (first one wins — possible only via hand-edited
 *  backups). Every consumer of projected cells must use this list, never the raw registry. */
export function dedupeAccounts(all: InvestmentAccount[]): {
  accounts: InvestmentAccount[];
  duplicates: InvestmentAccount[];
} {
  const accounts: InvestmentAccount[] = [];
  const duplicates: InvestmentAccount[] = [];
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a.id)) duplicates.push(a);
    else {
      seen.add(a.id);
      accounts.push(a);
    }
  }
  return { accounts, duplicates };
}

/** The heart of the module: project every registry account from the opening
 *  month to `endMonth` (inclusive) using the given per-kind annual growth rates.
 *  Months with no expense record use a snapshot of `templates` (the standard items) when
 *  given — the best guess at what they will contribute — and zero flows otherwise. */
export function projectAccounts(
  data: PreRetirementData,
  expenseMonths: ExpenseMonth[],
  rates: KindRates,
  endMonth: string,
  templates?: ExpenseTemplates,
  giltPricing?: GiltPricing,
): PreRetirementResult {
  const warnings: string[] = [];
  const pricing = giltPricing ?? buildPricing(null);

  const { accounts, duplicates } = dedupeAccounts(data.accounts);
  for (const a of duplicates) warnings.push(`Duplicate account id "${a.id}" — ignoring "${a.name}".`);

  const trackedKeys = new Set(expenseMonths.map((m) => m.key));
  const range = endMonth < data.openingMonth ? [] : monthKeysBetween(data.openingMonth, endMonth);
  const missingMonthKeys = range.filter((k) => !trackedKeys.has(k));
  const assumedMonths = templates ? missingMonthKeys.map((k) => createMonthFromTemplates(templates, k)) : [];

  const { flows, unknownAccountIds } = monthlyFlows([...expenseMonths, ...assumedMonths], accounts, range);
  if (unknownAccountIds.length > 0) {
    warnings.push(
      `Expense lines are tagged to unknown/deleted account(s), treated as untagged: ${unknownAccountIds.join(", ")}.`,
    );
  }

  if (endMonth < data.openingMonth) {
    return { accounts, months: [], warnings, missingMonthKeys: [], assumedMonths: [], unknownAccountIds, pricing };
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
  const overrideMap = new Map<string, { day: number | null; value: number; basis: number | null }>();
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
      overrideMap.set(k, { day: o.day ?? null, value: o.value, basis: o.basis ?? null });
    }
  }

  if (missingMonthKeys.length > 0) {
    const first = monthLabel(missingMonthKeys[0]);
    const last = monthLabel(missingMonthKeys[missingMonthKeys.length - 1]);
    warnings.push(
      `${missingMonthKeys.length} month(s) in the forecast range have no expense record ` +
        `(${missingMonthKeys.length === 1 ? first : `${first} … ${last}`}) — ` +
        (templates ? "assumed the standard items' tagged contributions." : "assumed zero contributions."),
    );
  }

  // Real gilts: accounts holding lots are their cash plus the lots at market value.
  const lotMap = lotsByAccount(data, accounts);
  for (const l of data.giltLots) {
    if (lotMap.get(l.accountId)?.includes(l)) continue;
    const acc = byId.get(l.accountId);
    warnings.push(
      acc
        ? `Gilt holding ${l.name} is in ${acc.name}, which isn't a gilts account — ignored.`
        : `Gilt holding ${l.name} is in an unknown/deleted account — ignored.`,
    );
  }
  const openingEve = addDays(`${data.openingMonth}-01`, -1);
  if (lotMap.size > 0) {
    if (!pricing.hasMarket) {
      warnings.push("Gilt holdings are valued at par: there are no DMO prices yet (refresh the gilt market).");
    } else {
      const unknown = [...new Set(data.giltLots.filter((l) => !pricing.knows(l.isin)).map((l) => l.name))];
      if (unknown.length > 0) {
        warnings.push(`No DMO price for ${unknown.join(", ")} — valued on the fitted yield curve.`);
      }
    }
    for (const [id, lots] of lotMap) {
      const a = byId.get(id)!;
      const held = lotsValue(lots, openingEve, pricing);
      if (held > 0 && a.openingBalance > 0 && Math.abs(a.openingBalance - held) <= 0.02 * held) {
        warnings.push(
          `${a.name}'s opening balance looks like the value of its gilts — with gilt holdings recorded it is the ` +
            `account's cash only (the gilts are counted separately).`,
        );
      }
    }
  }

  const balances = new Map<string, number>();
  const basis = new Map<string, number>();
  const giltCash = new Map<string, number>();
  for (const a of accounts) {
    const lots = lotMap.get(a.id);
    balances.set(a.id, a.openingBalance + (lots ? lotsValue(lots, openingEve, pricing) : 0));
    if (lots) giltCash.set(a.id, a.openingBalance);
    if (a.kind === "gia") {
      basis.set(a.id, a.openingBalance * (1 - clamp01(a.openingGainFraction ?? 0)));
    }
  }
  const negativeCash = new Map<string, string>();

  const months: ProjectionMonth[] = [];
  // First month and lowest value of any account driven below zero (withdrawals exceeding it).
  const negative = new Map<string, { firstKey: string; low: number }>();
  for (const key of range) {
    const monthFlows = flows.get(key);
    const byAccount: Record<string, AccountMonthCell> = {};
    let total = 0;
    for (const a of accounts) {
      const start = balances.get(a.id)!;
      const monthlyRate = annualToMonthly(rates[a.kind]);
      // A negative balance is a shortfall, not an investment: it doesn't grow.
      const f = monthFlows?.get(a.id);
      const monthContributions = f?.contributions ?? 0;
      const monthWithdrawals = f?.withdrawals ?? 0;
      const monthGrowth = cappedGrowth(
        a,
        start + monthContributions - monthWithdrawals,
        Math.max(0, start) * monthlyRate,
      );
      const record = overrideMap.get(`${a.id}:${key}`);

      const lots = lotMap.get(a.id);
      let cell: AccountMonthCell;
      if (lots) {
        // Cash moves by the tagged flows, purchases, and (unless paid out) coupons and
        // redemptions; the lots are revalued at the month end. Growth is what's left: price
        // movement and accrued interest. From a record, its cash is its value less the lots.
        const external = a.giltPayout === "external";
        let cash: number;
        let fromIso: string;
        let contributions: number;
        let withdrawals: number;
        if (record == null) {
          cash = giltCash.get(a.id)!;
          fromIso = addDays(`${key}-01`, -1);
          contributions = monthContributions;
          withdrawals = monthWithdrawals;
        } else {
          const day = clampDay(record.day, key);
          fromIso = `${key}-${String(day).padStart(2, "0")}`;
          cash = record.value - lotsValue(lots, fromIso, pricing);
          contributions = (f?.contributionsByDay ?? []).filter((c) => (c.day ?? 1) > day).reduce((s, c) => s + c.amount, 0);
          withdrawals = 0;
        }
        const endIso = monthEnd(key);
        const gf = giltFlowsBetween(lots, fromIso, endIso, pricing);
        cash += contributions - withdrawals - gf.purchases + (external ? 0 : gf.income);
        const out = withdrawals + (external ? gf.income : 0);
        const end = cash + lotsValue(lots, endIso, pricing);
        cell = {
          start,
          growth: end - (record?.value ?? start) - contributions + out,
          contributions,
          withdrawals: out,
          end,
          recorded: record ?? null,
        };
        giltCash.set(a.id, cash);
        if (cash < -0.5 && !negativeCash.has(a.id)) negativeCash.set(a.id, key);
      } else if (record == null) {
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
        const day = clampDay(record.day, key);
        const contributions = (f?.contributionsByDay ?? [])
          .filter((c) => (c.day ?? 1) > day)
          .reduce((s, c) => s + c.amount, 0);
        const growth = cappedGrowth(
          a,
          record.value + contributions,
          Math.max(0, record.value) * (Math.pow(1 + monthlyRate, (dim - day) / dim) - 1),
        );
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
        let b: number;
        if (record?.basis != null) {
          // A recorded basis re-anchors it; contributions due after the record still add.
          b = record.basis + cell.contributions;
        } else {
          // Basis grows with the month's full contributions (they are real money in whether
          // or not a record absorbs them); withdrawals take basis out in proportion to the
          // value sold — the recorded value, when there is one. Growth and recorded balances
          // change the embedded gain, never the basis.
          b = basis.get(a.id)! + monthContributions;
          const valueBeforeWithdrawal = cell.end + monthWithdrawals;
          if (monthWithdrawals > 0 && valueBeforeWithdrawal > 0) {
            b -= monthWithdrawals * (b / valueBeforeWithdrawal);
          }
        }
        basis.set(a.id, Math.max(0, b));
      }

      if (!lots && a.kind === "gilts" && a.maturityYear != null && a.maturityYear <= Number(endMonth.slice(0, 4)) && key === range[0]) {
        warnings.push(
          `${a.name} matures in ${a.maturityYear}, by the end of the projection — it is still held at ` +
            `nominal value; record the redemption (a balance of 0, and the cash where it went) when it happens.`,
        );
      }

      byAccount[a.id] = cell;
      balances.set(a.id, cell.end);
      total += cell.end;
      if (cell.end < -0.005) {
        const n = negative.get(a.id);
        if (!n) negative.set(a.id, { firstKey: key, low: cell.end });
        else n.low = Math.min(n.low, cell.end);
      }
    }
    months.push({ key, byAccount, basis: Object.fromEntries(basis), giltCash: Object.fromEntries(giltCash), total });
  }

  for (const [id, key] of negativeCash) {
    warnings.push(
      `${byId.get(id)!.name}'s cash goes below zero in ${monthLabel(key)} — its gilt purchases cost more than the ` +
        `cash in the account (tag the money paid in, or check the opening cash).`,
    );
  }

  for (const a of accounts) {
    const n = negative.get(a.id);
    if (!n) continue;
    warnings.push(
      `${a.name} goes below zero in ${monthLabel(n.firstKey)} (lowest ${Math.round(n.low).toLocaleString("en-GB")}) ` +
        `— the withdrawals tagged to it exceed its balance.`,
    );
  }

  return { accounts, months, warnings, missingMonthKeys, assumedMonths, unknownAccountIds, pricing };
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

/** "yyyy-mm-dd" for a record's date — a null day means the end of the month,
 *  and a day past the month's length clamps to its last day (as the engine
 *  reads it). */
export function overrideDateIso(o: { monthKey: string; day: number | null }): string {
  return `${o.monthKey}-${String(clampDay(o.day, o.monthKey)).padStart(2, "0")}`;
}

export interface LatestActualTotal {
  /** Σ each account's latest user-entered figure. */
  total: number;
  /** "yyyy-mm-dd" of the most recent record in the total; null if there is none. */
  latestDate: string | null;
  /** Accounts whose figure came from a recorded actual balance. */
  recordedCount: number;
  /** Accounts with no record, falling back to their opening balance. */
  openingCount: number;
  /** Gilt accounts holding real gilts with no record: their opening cash plus the gilts at the
   *  latest DMO prices. */
  giltValuedCount: number;
}

/** Σ the latest balance figure the user has entered for each account, with no
 *  projection at all: its most recent recorded actual balance (the Accounts
 *  tab's "Latest actual balance" column), or its opening balance when it has
 *  none. No growth, no tagged flows — so the figures can be dated differently
 *  per account; `latestDate` is the most recent record contributing.
 *
 *  Given `gilts` (the pricing and the date of the latest DMO prices), a gilt account holding real
 *  gilts with no record counts as its opening cash — less what holdings bought since the opening
 *  month cost, never below zero (the purchases came out of it first) — plus the gilts held on
 *  that date at those prices. Its coupons and redemptions aren't added (nothing is projected). */
export function latestActualTotal(
  data: PreRetirementData,
  gilts?: { pricing: GiltPricing; dateIso: string },
): LatestActualTotal {
  let total = 0;
  let latestDate: string | null = null;
  let recordedCount = 0;
  let openingCount = 0;
  let giltValuedCount = 0;
  const accounts = dedupeAccounts(data.accounts).accounts;
  const lotMap = gilts ? lotsByAccount(data, accounts) : new Map<string, never[]>();
  const openingStart = `${data.openingMonth}-01`;
  for (const a of accounts) {
    const latest = latestOverride(data, a.id);
    const lots = lotMap.get(a.id);
    if (latest) {
      total += latest.value;
      recordedCount++;
      const iso = overrideDateIso(latest);
      if (latestDate == null || iso > latestDate) latestDate = iso;
    } else if (gilts && lots) {
      const spent = lots
        .filter((l) => l.purchaseDate >= openingStart && l.purchaseDate <= gilts.dateIso)
        .reduce((s, l) => s + lotCost(l, gilts.pricing), 0);
      total += Math.max(0, a.openingBalance - spent) + lotsValue(lots, gilts.dateIso, gilts.pricing);
      giltValuedCount++;
      if (latestDate == null || gilts.dateIso > latestDate) latestDate = gilts.dateIso;
    } else {
      total += a.openingBalance;
      openingCount++;
    }
  }
  return { total, latestDate, recordedCount, openingCount, giltValuedCount };
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
  return sampleAtDate(result, data, expenseMonths, rates, dateIso).balances;
}

/** A projection sampled at the end of one day: each account's balance and, for GIA
 *  accounts, its cost basis (for the CGT handoff); for gilt accounts holding real gilts, the
 *  cash part of the balance. */
export interface DateSample {
  balances: Record<string, number>;
  basis: Record<string, number>;
  giltCash: Record<string, number>;
}

/** `balancesAtDate` plus the GIA cost basis on that day. The basis follows the same
 *  intra-month model: the previous month-end basis, plus contributions due by the day, less
 *  the basis taken out by the month's withdrawals (which move at the start of the month).
 *  Recorded balances never change the basis. At a month's last day it equals the month's
 *  basis exactly. */
export function sampleAtDate(
  result: PreRetirementResult,
  data: PreRetirementData,
  expenseMonths: ExpenseMonth[],
  rates: KindRates,
  dateIso: string,
): DateSample {
  const balances: Record<string, number> = {};
  const basis: Record<string, number> = {};
  const giltCash: Record<string, number> = {};
  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  if (!first || !last) return { balances, basis, giltCash };
  const lotMap = lotsByAccount(data, result.accounts);
  const openingBasis = (a: InvestmentAccount) => a.openingBalance * (1 - clamp01(a.openingGainFraction ?? 0));
  const monthKey = dateIso.slice(0, 7);
  if (monthKey < first.key) {
    for (const a of result.accounts) {
      balances[a.id] = first.byAccount[a.id].start;
      if (a.kind === "gia") basis[a.id] = openingBasis(a);
      if (lotMap.has(a.id)) giltCash[a.id] = a.openingBalance;
    }
    return { balances, basis, giltCash };
  }
  if (monthKey > last.key) {
    for (const a of result.accounts) {
      balances[a.id] = last.byAccount[a.id].end;
      if (a.kind === "gia") basis[a.id] = last.basis[a.id] ?? 0;
      if (lotMap.has(a.id)) giltCash[a.id] = last.giltCash[a.id] ?? 0;
    }
    return { balances, basis, giltCash };
  }
  const monthIdx = result.months.findIndex((m) => m.key === monthKey);
  const month = result.months[monthIdx];
  if (!month) return { balances, basis, giltCash }; // unreachable: every month in the range is emitted
  const dim = daysInMonth(monthKey);
  const day = clampDay(Number(dateIso.slice(8, 10)) || null, monthKey);
  // The month the projection actually used: the tracked one, else what it assumed.
  const { flows } = monthlyFlows(
    [...expenseMonths, ...result.assumedMonths].filter((m) => m.key === monthKey).slice(0, 1),
    result.accounts,
    [monthKey],
  );
  const monthFlows = flows.get(monthKey);
  for (const a of result.accounts) {
    const cell = month.byAccount[a.id];
    if (!cell) continue;
    // Latest record on or before the date, with the engine's tie-breaking
    // (null day = end of month, later entries win ties).
    let anchor: { eff: number; day: number; value: number; basis: number | null } | null = null;
    for (const o of data.overrides) {
      if (o.accountId !== a.id || o.monthKey !== monthKey) continue;
      const oDay = clampDay(o.day, monthKey);
      if (oDay > day) continue;
      const eff = o.day ?? 32;
      if (!anchor || eff >= anchor.eff) anchor = { eff, day: oDay, value: o.value, basis: o.basis ?? null };
    }
    const from = anchor?.day ?? 0;
    const base = anchor?.value ?? cell.start;
    const monthlyRate = annualToMonthly(rates[a.kind]);
    const f = monthFlows?.get(a.id);
    const byDay = f?.contributionsByDay ?? [];
    const contributions = byDay
      .filter((c) => {
        const d = c.day ?? 1;
        return d > from && d <= day;
      })
      .reduce((s, c) => s + c.amount, 0);
    // Income lines carry no due day: they move at the start of the month, so
    // they are gone by any sampled day and inside any anchor.
    const withdrawals = anchor ? 0 : (f?.withdrawals ?? 0);
    const lots = lotMap.get(a.id);
    if (lots) {
      // Mirrors projectAccounts: cash from the anchor (a record less the lots, or last month's
      // cash), moved by the flows up to the day; the lots at that day's market value.
      const dayIso = `${monthKey}-${String(day).padStart(2, "0")}`;
      const fromIso = anchor ? `${monthKey}-${String(anchor.day).padStart(2, "0")}` : addDays(`${monthKey}-01`, -1);
      const prevCash = monthIdx > 0 ? (result.months[monthIdx - 1].giltCash[a.id] ?? 0) : a.openingBalance;
      let cash = anchor ? anchor.value - lotsValue(lots, fromIso, result.pricing) : prevCash;
      const gf = giltFlowsBetween(lots, fromIso, dayIso, result.pricing);
      cash += contributions - withdrawals - gf.purchases + (a.giltPayout === "external" ? 0 : gf.income);
      giltCash[a.id] = cash;
      balances[a.id] = cash + lotsValue(lots, dayIso, result.pricing);
      continue;
    }
    const growth = cappedGrowth(
      a,
      base + contributions - withdrawals,
      Math.max(0, base) * (Math.pow(1 + monthlyRate, (day - from) / dim) - 1),
    );
    balances[a.id] = base + growth + contributions - withdrawals;

    if (a.kind === "gia") {
      if (anchor?.basis != null) {
        // Mirrors projectAccounts: a recorded basis re-anchors it.
        basis[a.id] = Math.max(0, anchor.basis + contributions);
      } else {
        const prevBasis = monthIdx > 0 ? (result.months[monthIdx - 1].basis[a.id] ?? 0) : openingBasis(a);
        const allContribs = f?.contributions ?? 0;
        const dueContribs = byDay.filter((c) => (c.day ?? 1) <= day).reduce((s, c) => s + c.amount, 0);
        const W = f?.withdrawals ?? 0;
        // Mirrors projectAccounts: withdrawals remove basis in proportion to the value sold.
        const valueBeforeWithdrawal = cell.end + W;
        let b = prevBasis + dueContribs;
        if (W > 0 && valueBeforeWithdrawal > 0) b -= W * ((prevBasis + allContribs) / valueBeforeWithdrawal);
        basis[a.id] = Math.max(0, b);
      }
    }
  }
  return { balances, basis, giltCash };
}
