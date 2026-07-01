import { create } from "zustand";
import type { Scenario } from "../model/types";
import { defaultScenario } from "../model/defaults";

const LS_KEY = "retirement-forecast:scenarios";
const LS_ACTIVE = "retirement-forecast:active";

interface Persisted {
  scenarios: Scenario[];
  activeId: string;
}

/** Backfill fields added in later versions so older saved scenarios keep working. */
function migrate(s: Scenario): Scenario {
  const d = defaultScenario();
  return {
    ...s,
    income: { ...s.income, mode: s.income.mode ?? "fixed", swrRate: s.income.swrRate ?? d.income.swrRate },
    strategy: { ...s.strategy, taxMode: s.strategy.taxMode ?? "heuristic" },
    purchases: s.purchases ?? [],
  };
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Scenario[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const scenarios = parsed.map(migrate);
        const activeId = localStorage.getItem(LS_ACTIVE) ?? scenarios[0].id;
        return { scenarios, activeId };
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  const d = defaultScenario();
  return { scenarios: [d], activeId: d.id };
}

function save(scenarios: Scenario[], activeId: string): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(scenarios));
    localStorage.setItem(LS_ACTIVE, activeId);
  } catch {
    /* storage may be unavailable */
  }
}

interface Store {
  scenarios: Scenario[];
  activeId: string;
  active: () => Scenario;
  setActive: (id: string) => void;
  update: (mut: (s: Scenario) => void) => void;
  addScenario: (name?: string) => void;
  duplicateActive: () => void;
  deleteActive: () => void;
  rename: (name: string) => void;
  importScenario: (s: Scenario) => void;
  resetActiveToDefault: () => void;
}

const initial = load();

/** Structured-clone-ish deep copy that works for our plain-data scenarios. */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export const useStore = create<Store>((set, get) => ({
  scenarios: initial.scenarios,
  activeId: initial.activeId,
  active: () => {
    const { scenarios, activeId } = get();
    return scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  },
  setActive: (id) =>
    set((st) => {
      save(st.scenarios, id);
      return { activeId: id };
    }),
  update: (mut) =>
    set((st) => {
      const scenarios = st.scenarios.map((s) => {
        if (s.id !== st.activeId) return s;
        const copy = clone(s);
        mut(copy);
        return copy;
      });
      save(scenarios, st.activeId);
      return { scenarios };
    }),
  addScenario: (name) =>
    set((st) => {
      const d = defaultScenario();
      d.id = `sc-${Date.now()}`;
      d.name = name ?? "New scenario";
      const scenarios = [...st.scenarios, d];
      save(scenarios, d.id);
      return { scenarios, activeId: d.id };
    }),
  duplicateActive: () =>
    set((st) => {
      const src = st.scenarios.find((s) => s.id === st.activeId)!;
      const copy = clone(src);
      copy.id = `sc-${Date.now()}`;
      copy.name = `${src.name} (copy)`;
      const scenarios = [...st.scenarios, copy];
      save(scenarios, copy.id);
      return { scenarios, activeId: copy.id };
    }),
  deleteActive: () =>
    set((st) => {
      if (st.scenarios.length <= 1) return st;
      const scenarios = st.scenarios.filter((s) => s.id !== st.activeId);
      const activeId = scenarios[0].id;
      save(scenarios, activeId);
      return { scenarios, activeId };
    }),
  rename: (name) => get().update((s) => (s.name = name)),
  importScenario: (s) =>
    set((st) => {
      const copy = clone(s);
      copy.id = `sc-${Date.now()}`;
      const scenarios = [...st.scenarios, copy];
      save(scenarios, copy.id);
      return { scenarios, activeId: copy.id };
    }),
  resetActiveToDefault: () =>
    set((st) => {
      const d = defaultScenario();
      const scenarios = st.scenarios.map((s) =>
        s.id === st.activeId ? { ...d, id: s.id, name: s.name } : s,
      );
      save(scenarios, st.activeId);
      return { scenarios };
    }),
}));
