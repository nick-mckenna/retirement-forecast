import type { Scenario } from "./types";
import type { ExpenseData } from "./expenseTypes";
import { defaultScenario } from "./defaults";

/**
 * Backfill fields added in later versions so older saved scenarios (from the
 * database, localStorage or an imported JSON backup) keep working.
 */
export function migrateScenario(s: Scenario): Scenario {
  const d = defaultScenario();
  return {
    ...s,
    income: { ...s.income, mode: s.income.mode ?? "fixed", swrRate: s.income.swrRate ?? d.income.swrRate },
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
      expenses: d.templates?.expenses ?? [],
      income: d.templates?.income ?? [],
    },
    months: (d.months ?? []).map((m) => ({
      ...m,
      currentBalance: m.currentBalance ?? null,
      expenses: m.expenses ?? [],
      income: m.income ?? [],
    })),
  };
}
