// The handoff between the pre-retirement projection and the retirement
// forecast. Pure, like project.ts. The rule that prevents double counting:
// the projection for a linked scenario ends at the last full month strictly
// BEFORE the scenario's startDate month; the retirement engine owns
// everything from startDate onwards, so tagged flows in that month or later
// never reach the handoff balances.
//
// Accounts aggregate into retirement pots by (owner, kind): isa→isa,
// pension→pension, gia→gia (with the tracked cost basis turned into
// giaGainFraction), savings + premiumBonds → savings (both count as
// "savings" for the retirement buffer), gilts→gilts.

import type { PersonId, Scenario, StartingBalances } from "../model/types";
import type { ExpenseMonth } from "../model/expenseTypes";
import type { InvestmentAccount, PreRetirementData } from "../model/preRetirementTypes";
import { PERSON_IDS } from "../model/preRetirementTypes";
import { addMonths, monthLabel } from "../expenses/calc";
import { projectAccounts, ratesForKinds, type PreRetirementResult } from "./project";

/** End of the last full month strictly before startDate's month:
 *  "2033-04-05" → "2033-03". (Sliced from the ISO string, not via Date, so
 *  the result never depends on the machine's timezone.) */
export function handoffMonthKey(scenarioStartDate: string): string {
  return addMonths(scenarioStartDate.slice(0, 7), -1);
}

/** Aggregate the projection's final month into retirement starting balances
 *  by (owner, kind). Assumes the projection was run with the handoff month as
 *  its endMonth (resolveLinkedBalances guarantees this). */
export function handoffBalances(
  result: PreRetirementResult,
  accounts: InvestmentAccount[],
): Record<PersonId, StartingBalances> | null {
  const last = result.months[result.months.length - 1];
  if (!last) return null;
  const out = {} as Record<PersonId, StartingBalances>;
  for (const p of PERSON_IDS) {
    out[p] = { isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0, giaGainFraction: 0 };
  }
  const giaBasis: Record<PersonId, number> = { nick: 0, tracy: 0 };
  for (const a of accounts) {
    const cell = last.byAccount[a.id];
    if (!cell) continue; // duplicate id dropped by the engine
    const pots = out[a.owner];
    switch (a.kind) {
      case "isa":
        pots.isa += cell.end;
        break;
      case "pension":
        pots.pension += cell.end;
        break;
      case "gia":
        pots.gia += cell.end;
        giaBasis[a.owner] += last.basis[a.id] ?? 0;
        break;
      case "savings":
      case "premiumBonds":
        pots.savings += cell.end;
        break;
      case "gilts":
        pots.gilts += cell.end;
        break;
    }
  }
  for (const p of PERSON_IDS) {
    const gia = out[p].gia;
    out[p].giaGainFraction = gia > 0 ? Math.min(1, Math.max(0, (gia - giaBasis[p]) / gia)) : 0;
  }
  return out;
}

/** Effective starting balances for a linked scenario, computed with THAT
 *  scenario's rates. Falls back to the scenario's manual balances (with a
 *  warning) when the projection cannot cover the handoff month or the
 *  account registry is empty. */
export function resolveLinkedBalances(
  scenario: Scenario,
  pre: PreRetirementData,
  expenseMonths: ExpenseMonth[],
): { balances: Record<PersonId, StartingBalances>; warnings: string[] } {
  const endMonth = handoffMonthKey(scenario.startDate);
  if (pre.accounts.length === 0) {
    return {
      balances: scenario.balances,
      warnings: [
        "Pre-retirement link: no accounts are set up in the Pre-retirement module — using the scenario's manual balances instead.",
      ],
    };
  }
  if (endMonth < pre.openingMonth) {
    return {
      balances: scenario.balances,
      warnings: [
        `Pre-retirement link: the scenario starts (${scenario.startDate}) before the pre-retirement ` +
          `opening month (${monthLabel(pre.openingMonth)}) — using the scenario's manual balances instead.`,
      ],
    };
  }
  const result = projectAccounts(pre, expenseMonths, ratesForKinds(scenario.rates), endMonth);
  const balances = handoffBalances(result, pre.accounts);
  if (!balances) {
    return {
      balances: scenario.balances,
      warnings: ["Pre-retirement link: the projection is empty — using the scenario's manual balances instead."],
    };
  }
  return { balances, warnings: result.warnings.map((w) => `Pre-retirement link: ${w}`) };
}

/** What the UI feeds to runForecast: the scenario itself when the link is
 *  off, else a copy with the projected balances. Keeps simulate() pure. */
export function resolveScenarioForRun(
  scenario: Scenario,
  pre: PreRetirementData,
  expenseMonths: ExpenseMonth[],
): { scenario: Scenario; warnings: string[] } {
  if (!scenario.linkPreRetirement) return { scenario, warnings: [] };
  const { balances, warnings } = resolveLinkedBalances(scenario, pre, expenseMonths);
  return { scenario: { ...scenario, balances }, warnings };
}
