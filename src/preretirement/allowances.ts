// Allowance checks for the pre-retirement projection (pure). Contributions are read from the
// same flows the projection uses — tagged expense lines (pension relief at source grossed up),
// outside contributions on each month's last day, and the standard items for untracked months —
// and placed in the UK tax year of their due day. Planning aid only: the checks are simplified
// and say so in their wording.

import type { ExpenseMonth } from "../model/expenseTypes";
import type { PersonId, Scenario } from "../model/types";
import { PERSON_IDS } from "../model/preRetirementTypes";
import { monthLabel } from "../expenses/calc";
import { resolveTaxParams } from "../tax/taxParams";
import { PENSION_ANNUAL_ALLOWANCE, PREMIUM_BOND_LIMIT } from "../tax/allowanceLimits";
import { monthlyFlows, type PreRetirementResult } from "./project";

/** The UK tax year (calendar year of its 6 April) a flow due on `day` of `monthKey` falls in.
 *  An undated line counts as due on the 1st, as everywhere else in the projection. */
export function taxYearOfDay(monthKey: string, day: number | null): number {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  return m > 4 || (m === 4 && (day ?? 1) >= 6) ? y : y - 1;
}

function yearLabel(y: number): string {
  return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

function money(x: number): string {
  return `£${Math.round(x).toLocaleString("en-GB")}`;
}

/**
 * Warnings for the projection's contributions and holdings that break an allowance:
 * - ISA: more than the year's ISA allowance (from the scenario's tax parameters) into one
 *   person's ISAs in a tax year;
 * - pension: more than the £60,000 annual allowance gross into one person's pensions in a tax
 *   year (simplified — no carry-forward, taper or money-purchase limit);
 * - Premium Bonds: one person's holding projected above the £50,000 limit (prizes stop at the
 *   limit in the projection, so this is money put in — opening balance, records, contributions).
 * Tax years at the edges of the projection only count the months it covers.
 */
export function allowanceWarnings(
  result: PreRetirementResult,
  expenseMonths: ExpenseMonth[],
  scenario: Scenario,
): string[] {
  const keys = result.months.map((m) => m.key);
  if (keys.length === 0) return [];
  const inRange = new Set(keys);
  const months = [...expenseMonths, ...result.assumedMonths].filter((m) => inRange.has(m.key));
  const { flows } = monthlyFlows(months, result.accounts, keys);
  const name = (p: PersonId) => scenario.people[p].name;

  // owner → kind → tax year → total contributed.
  const totals = new Map<string, number>();
  const add = (owner: PersonId, kind: string, year: number, amount: number) => {
    const k = `${owner}|${kind}|${year}`;
    totals.set(k, (totals.get(k) ?? 0) + amount);
  };
  for (const [key, byAccount] of flows) {
    for (const a of result.accounts) {
      if (a.kind !== "isa" && a.kind !== "pension") continue;
      const f = byAccount.get(a.id);
      if (!f) continue;
      for (const c of f.contributionsByDay) add(a.owner, a.kind, taxYearOfDay(key, c.day), c.amount);
    }
  }

  const warnings: string[] = [];
  const years = [...new Set([...totals.keys()].map((k) => Number(k.split("|")[2])))].sort((a, b) => a - b);
  for (const year of years) {
    for (const p of PERSON_IDS) {
      const isa = totals.get(`${p}|isa|${year}`) ?? 0;
      const isaLimit = resolveTaxParams(scenario.taxParams, year, scenario.taxPolicy, scenario.rates.inflation).isaAllowance;
      if (isa > isaLimit + 0.005) {
        warnings.push(
          `${name(p)}: ${money(isa)} goes into ISAs in tax year ${yearLabel(year)} — over the ${money(isaLimit)} ISA allowance.`,
        );
      }
      const pension = totals.get(`${p}|pension|${year}`) ?? 0;
      if (pension > PENSION_ANNUAL_ALLOWANCE + 0.005) {
        warnings.push(
          `${name(p)}: ${money(pension)} gross goes into pensions in tax year ${yearLabel(year)} — over the ` +
            `${money(PENSION_ANNUAL_ALLOWANCE)} annual allowance (simplified: carry-forward, the taper and the ` +
            `money-purchase limit aren't checked).`,
        );
      }
    }
  }

  for (const p of PERSON_IDS) {
    const bonds = result.accounts.filter((a) => a.owner === p && a.kind === "premiumBonds");
    if (bonds.length === 0) continue;
    let first: string | null = null;
    let peak = 0;
    for (const m of result.months) {
      const held = bonds.reduce((s, a) => s + (m.byAccount[a.id]?.end ?? 0), 0);
      if (held > PREMIUM_BOND_LIMIT + 0.005) {
        first ??= m.key;
        peak = Math.max(peak, held);
      }
    }
    if (first) {
      warnings.push(
        `${name(p)}'s Premium Bonds reach ${money(peak)} (over the ${money(PREMIUM_BOND_LIMIT)} holding limit from ` +
          `${monthLabel(first)}) — NS&I won't hold more than the limit per person.`,
      );
    }
  }
  return warnings;
}
