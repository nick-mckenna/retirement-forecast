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
import type { PreRetirementData } from "../model/preRetirementTypes";
import { PERSON_IDS } from "../model/preRetirementTypes";
import { addMonths, monthLabel } from "../expenses/calc";
import { isIsoDate } from "../tax/taxYear";
import { projectAccounts, ratesForKinds, type PreRetirementResult } from "./project";

/** End of the last full month strictly before startDate's month:
 *  "2033-04-05" → "2033-03". (Sliced from the ISO string, not via Date, so
 *  the result never depends on the machine's timezone.) Null when the start
 *  date isn't a valid date (e.g. the date field was cleared). */
export function handoffMonthKey(scenarioStartDate: string): string | null {
  if (!isIsoDate(scenarioStartDate)) return null;
  return addMonths(scenarioStartDate.slice(0, 7), -1);
}

/** True when nothing has been entered in the registry yet: every opening balance, every
 *  recorded balance and every projected month-end is zero (the generic sample registry as
 *  shipped). Linking to it would silently swap real manual balances for £0. */
export function isUnconfigured(pre: PreRetirementData, result: PreRetirementResult): boolean {
  if (pre.accounts.some((a) => a.openingBalance !== 0)) return false;
  if (pre.overrides.some((o) => o.value !== 0)) return false;
  const last = result.months[result.months.length - 1];
  return !last || Object.values(last.byAccount).every((c) => c.end === 0);
}

/** Aggregate the projection's final month into retirement starting balances
 *  by (owner, kind). Assumes the projection was run with the handoff month as
 *  its endMonth (resolveLinkedBalances guarantees this). A pot driven below zero
 *  is clamped to 0 (the retirement engine assumes non-negative pots), with a warning. */
export function handoffBalances(
  result: PreRetirementResult,
): { balances: Record<PersonId, StartingBalances>; warnings: string[] } | null {
  const last = result.months[result.months.length - 1];
  if (!last) return null;
  const out = {} as Record<PersonId, StartingBalances>;
  for (const p of PERSON_IDS) {
    out[p] = { isa: 0, pension: 0, gia: 0, savings: 0, gilts: 0, giaGainFraction: 0 };
  }
  const giaBasis: Record<PersonId, number> = { nick: 0, tracy: 0 };
  for (const a of result.accounts) {
    const cell = last.byAccount[a.id];
    if (!cell) continue;
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
  const warnings: string[] = [];
  const POTS = ["isa", "pension", "gia", "savings", "gilts"] as const;
  for (const p of PERSON_IDS) {
    for (const k of POTS) {
      if (out[p][k] < 0) {
        warnings.push(
          `${p === "nick" ? "Person A" : "Person B"}'s ${k} pot projects to ${Math.round(out[p][k]).toLocaleString("en-GB")} ` +
            `at the handoff — treated as 0.`,
        );
        out[p][k] = 0;
      }
    }
    const gia = out[p].gia;
    out[p].giaGainFraction = gia > 0 ? Math.min(1, Math.max(0, (gia - giaBasis[p]) / gia)) : 0;
  }
  return { balances: out, warnings };
}

/** Effective starting balances for a linked scenario, computed with THAT
 *  scenario's rates. Falls back to the scenario's manual balances (with a
 *  warning) when the start date is invalid, the projection cannot cover the
 *  handoff month, or the account registry is empty or still unconfigured. */
export function resolveLinkedBalances(
  scenario: Scenario,
  pre: PreRetirementData,
  expenseMonths: ExpenseMonth[],
): { balances: Record<PersonId, StartingBalances>; warnings: string[] } {
  const endMonth = handoffMonthKey(scenario.startDate);
  if (endMonth == null) {
    return {
      balances: scenario.balances,
      warnings: [
        "Pre-retirement link: the model start date isn't a valid date — using the scenario's manual balances instead.",
      ],
    };
  }
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
  const handoff = handoffBalances(result);
  if (!handoff) {
    return {
      balances: scenario.balances,
      warnings: ["Pre-retirement link: the projection is empty — using the scenario's manual balances instead."],
    };
  }
  if (isUnconfigured(pre, result)) {
    return {
      balances: scenario.balances,
      warnings: [
        "Pre-retirement link: no balances have been entered in the Pre-retirement module yet (every " +
          "account is at zero) — using the scenario's manual balances instead.",
      ],
    };
  }
  return {
    balances: handoff.balances,
    warnings: [...result.warnings, ...handoff.warnings].map((w) => `Pre-retirement link: ${w}`),
  };
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
