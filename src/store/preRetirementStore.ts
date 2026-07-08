import { create } from "zustand";
import type { PreRetirementData } from "../model/preRetirementTypes";
import { defaultPreRetirementData } from "../model/preRetirementTypes";
import { migratePreRetirementData } from "../model/migrate";
import { api } from "../api/client";
import type { DbStatus } from "./scenarioStore";

// Same persistence contract as the other stores: SQL Server (via the local
// API) is the source of truth, localStorage is a write-through cache. The
// whole document is small (an account registry + overrides), so it is saved
// as one unit through a single debounce slot.

const LS_KEY = "retirement-forecast:preretirement";

function loadLocal(): PreRetirementData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return migratePreRetirementData(JSON.parse(raw) as PreRetirementData);
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return defaultPreRetirementData();
}

function saveLocal(data: PreRetirementData): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* storage may be unavailable */
  }
}

interface PreRetirementStore {
  data: PreRetirementData;
  dbStatus: DbStatus;
  update: (mut: (d: PreRetirementData) => void) => void;
  /** Set (or with a null value, remove) the actual balance recorded for an
   *  account at the end of `day` in `monthKey` (day null = end of the month). */
  setOverride: (accountId: string, monthKey: string, day: number | null, value: number | null) => void;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export const usePreRetirementStore = create<PreRetirementStore>((set) => ({
  data: loadLocal(),
  dbStatus: "connecting",
  update: (mut) =>
    set((st) => {
      const data = clone(st.data);
      mut(data);
      saveLocal(data);
      queueSave();
      return { data };
    }),
  setOverride: (accountId, monthKey, day, value) =>
    set((st) => {
      const data = clone(st.data);
      data.overrides = data.overrides.filter(
        (o) => !(o.accountId === accountId && o.monthKey === monthKey && (o.day ?? null) === day),
      );
      if (value != null) data.overrides.push({ accountId, monthKey, day, value });
      saveLocal(data);
      queueSave();
      return { data };
    }),
}));

function setDbStatus(status: DbStatus): void {
  if (usePreRetirementStore.getState().dbStatus !== status) {
    usePreRetirementStore.setState({ dbStatus: status });
  }
}

/** Fire-and-forget persistence: flip the status chip instead of interrupting the user. */
async function track<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    const v = await p;
    setDbStatus("online");
    return v;
  } catch (e) {
    console.warn("Saving pre-retirement data failed:", e);
    setDbStatus("offline");
    return undefined;
  }
}

let pendingSave: ReturnType<typeof setTimeout> | undefined;

function queueSave(): void {
  clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    void track(api.savePreRetirement(usePreRetirementStore.getState().data));
  }, 400);
}

/** The server reports an empty document (no accounts) until something has
 *  been saved — mirrors the expense tracker, whose emptiness check is "any
 *  templates or months". Once anything is saved the database always wins. */
function hasContent(d: PreRetirementData): boolean {
  return d.accounts.length > 0 || d.overrides.length > 0;
}

/** After a backup restore: refresh from the database, or apply the backup's
 *  pre-retirement data locally when the restore only reached browser storage. */
export async function applyRestoredPreRetirement(
  fromBackup: PreRetirementData | undefined,
  where: "database" | "browser-only",
): Promise<void> {
  if (where === "database") {
    await initPreRetirementFromDb();
  } else if (fromBackup) {
    const data = migratePreRetirementData(fromBackup);
    saveLocal(data);
    usePreRetirementStore.setState({ data });
  }
}

/** Load from the database, seeding it from local data on first run. */
export async function initPreRetirementFromDb(): Promise<void> {
  try {
    const remote = migratePreRetirementData(await api.preRetirement());
    if (hasContent(remote)) {
      saveLocal(remote);
      usePreRetirementStore.setState({ data: remote, dbStatus: "online" });
    } else {
      const local = usePreRetirementStore.getState().data;
      if (hasContent(local)) await api.savePreRetirement(local);
      setDbStatus("online");
    }
  } catch (e) {
    console.warn("Pre-retirement API unreachable — using browser storage only.", e);
    setDbStatus("offline");
  }
}

if (typeof window !== "undefined") {
  void initPreRetirementFromDb();
  // Flush any debounced save before the tab goes away.
  window.addEventListener("pagehide", () => {
    if (pendingSave != null) {
      clearTimeout(pendingSave);
      pendingSave = undefined;
      void api.savePreRetirement(usePreRetirementStore.getState().data, true).catch(() => undefined);
    }
  });
}
