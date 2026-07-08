import { create } from "zustand";
import type { Scenario } from "../model/types";
import { defaultScenario } from "../model/defaults";
import { migrateScenario } from "../model/migrate";
import { api, type BackupFile, type RemoteState } from "../api/client";

// SQL Server (via the local API) is the source of truth. localStorage is kept
// as a write-through cache so the app still opens instantly and keeps working
// (dbStatus "offline") when the API or database is down; edits made offline
// live in the browser only until the next successful save.

const LS_KEY = "retirement-forecast:scenarios";
const LS_ACTIVE = "retirement-forecast:active";

export type DbStatus = "connecting" | "online" | "offline";

interface Persisted {
  scenarios: Scenario[];
  activeId: string;
}

function loadLocal(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Scenario[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const scenarios = parsed.map(migrateScenario);
        const activeId = localStorage.getItem(LS_ACTIVE) ?? scenarios[0].id;
        return { scenarios, activeId };
      }
    }
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  const d = defaultScenario();
  return { scenarios: [d], activeId: d.id };
}

function saveLocal(scenarios: Scenario[], activeId: string): void {
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
  dbStatus: DbStatus;
  active: () => Scenario;
  setActive: (id: string) => void;
  update: (mut: (s: Scenario) => void) => void;
  addScenario: (name?: string) => void;
  duplicateActive: () => void;
  deleteActive: () => void;
  rename: (name: string) => void;
  importScenario: (s: Scenario) => void;
  /** Restore a whole-database backup; returns where it ended up. */
  restoreBackup: (backup: BackupFile) => Promise<"database" | "browser-only">;
  resetActiveToDefault: () => void;
}

const initial = loadLocal();

/** Structured-clone-ish deep copy that works for our plain-data scenarios. */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export const useStore = create<Store>((set, get) => ({
  scenarios: initial.scenarios,
  activeId: initial.activeId,
  dbStatus: "connecting",
  active: () => {
    const { scenarios, activeId } = get();
    return scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  },
  setActive: (id) =>
    set((st) => {
      saveLocal(st.scenarios, id);
      void track(api.setActive(id));
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
      saveLocal(scenarios, st.activeId);
      queueSave(st.activeId);
      return { scenarios };
    }),
  addScenario: (name) =>
    set((st) => {
      const d = defaultScenario();
      d.id = `sc-${Date.now()}`;
      d.name = name ?? "New scenario";
      const scenarios = [...st.scenarios, d];
      saveLocal(scenarios, d.id);
      void track(api.saveScenario(d, scenarios.length - 1).then(() => api.setActive(d.id)));
      return { scenarios, activeId: d.id };
    }),
  duplicateActive: () =>
    set((st) => {
      const src = st.scenarios.find((s) => s.id === st.activeId)!;
      const copy = clone(src);
      copy.id = `sc-${Date.now()}`;
      copy.name = `${src.name} (copy)`;
      const scenarios = [...st.scenarios, copy];
      saveLocal(scenarios, copy.id);
      void track(api.saveScenario(copy, scenarios.length - 1).then(() => api.setActive(copy.id)));
      return { scenarios, activeId: copy.id };
    }),
  deleteActive: () =>
    set((st) => {
      if (st.scenarios.length <= 1) return st;
      const deletedId = st.activeId;
      cancelSave(deletedId);
      const scenarios = st.scenarios.filter((s) => s.id !== deletedId);
      const activeId = scenarios[0].id;
      saveLocal(scenarios, activeId);
      void track(api.deleteScenario(deletedId).then(() => api.setActive(activeId)));
      return { scenarios, activeId };
    }),
  rename: (name) => get().update((s) => (s.name = name)),
  importScenario: (s) =>
    set((st) => {
      const copy = migrateScenario(clone(s));
      copy.id = `sc-${Date.now()}`;
      const scenarios = [...st.scenarios, copy];
      saveLocal(scenarios, copy.id);
      void track(api.saveScenario(copy, scenarios.length - 1).then(() => api.setActive(copy.id)));
      return { scenarios, activeId: copy.id };
    }),
  restoreBackup: async (backup) => {
    const apply = (state: RemoteState, dbStatus: DbStatus) => {
      const scenarios = state.scenarios.map(migrateScenario);
      const activeId =
        state.activeId && scenarios.some((s) => s.id === state.activeId)
          ? state.activeId
          : scenarios[0].id;
      for (const s of scenarios) cancelSave(s.id);
      saveLocal(scenarios, activeId);
      set({ scenarios, activeId, dbStatus });
    };
    try {
      apply(await api.importBackup(backup), "online");
      return "database";
    } catch {
      apply({ scenarios: backup.scenarios, activeId: backup.activeId }, "offline");
      return "browser-only";
    }
  },
  resetActiveToDefault: () =>
    set((st) => {
      const d = defaultScenario();
      const scenarios = st.scenarios.map((s) =>
        s.id === st.activeId ? { ...d, id: s.id, name: s.name } : s,
      );
      saveLocal(scenarios, st.activeId);
      queueSave(st.activeId);
      return { scenarios };
    }),
}));

function setDbStatus(status: DbStatus): void {
  if (useStore.getState().dbStatus !== status) useStore.setState({ dbStatus: status });
}

/** Fire-and-forget persistence: flip the status chip instead of interrupting the user. */
async function track<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    const v = await p;
    setDbStatus("online");
    return v;
  } catch (e) {
    console.warn("Saving to the forecast database failed:", e);
    setDbStatus("offline");
    return undefined;
  }
}

// Edits arrive per keystroke; coalesce saves per scenario.
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

function queueSave(id: string): void {
  clearTimeout(pendingSaves.get(id));
  pendingSaves.set(
    id,
    setTimeout(() => {
      pendingSaves.delete(id);
      const st = useStore.getState();
      const index = st.scenarios.findIndex((s) => s.id === id);
      if (index >= 0) void track(api.saveScenario(st.scenarios[index], index));
    }, 400),
  );
}

function cancelSave(id: string): void {
  clearTimeout(pendingSaves.get(id));
  pendingSaves.delete(id);
}

/** Load from the database, seeding it from local data on first run. */
async function initFromDb(): Promise<void> {
  try {
    const remote = await api.state();
    if (remote.scenarios.length > 0) {
      const scenarios = remote.scenarios.map(migrateScenario);
      const activeId =
        remote.activeId && scenarios.some((s) => s.id === remote.activeId)
          ? remote.activeId
          : scenarios[0].id;
      saveLocal(scenarios, activeId);
      useStore.setState({ scenarios, activeId, dbStatus: "online" });
    } else {
      const st = useStore.getState();
      for (let i = 0; i < st.scenarios.length; i++) {
        await api.saveScenario(st.scenarios[i], i);
      }
      await api.setActive(st.activeId);
      setDbStatus("online");
    }
  } catch (e) {
    console.warn("Forecast API unreachable — using browser storage only.", e);
    setDbStatus("offline");
  }
}

if (typeof window !== "undefined") {
  void initFromDb();
  // Flush any debounced save before the tab goes away.
  window.addEventListener("pagehide", () => {
    const st = useStore.getState();
    for (const id of [...pendingSaves.keys()]) {
      cancelSave(id);
      const index = st.scenarios.findIndex((s) => s.id === id);
      if (index >= 0) void api.saveScenario(st.scenarios[index], index, true).catch(() => undefined);
    }
  });
}
