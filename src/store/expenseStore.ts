import { create } from "zustand";
import type { ExpenseData, ExpenseMonth, ExpenseTemplates } from "../model/expenseTypes";
import { defaultExpenseData } from "../model/expenseTypes";
import { migrateExpenseData } from "../model/migrate";
import { createMonthFromTemplates, monthKeyOf, nextMonthKey, sortedMonths, summariseMonth } from "../expenses/calc";
import { api } from "../api/client";
import type { DbStatus } from "./scenarioStore";

// Same persistence contract as scenarioStore: SQL Server (via the local API)
// is the source of truth, localStorage is a write-through cache so the tracker
// opens instantly and keeps working offline. Saves are debounced per month
// (and for the template set) because edits arrive per keystroke.

const LS_KEY = "retirement-forecast:expenses";

function loadLocal(): ExpenseData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return migrateExpenseData(JSON.parse(raw) as ExpenseData);
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return defaultExpenseData();
}

function saveLocal(data: ExpenseData): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* storage may be unavailable */
  }
}

interface ExpenseStore {
  data: ExpenseData;
  /** Month currently shown in the UI ("yyyy-mm"), or null when none exist. */
  selectedKey: string | null;
  dbStatus: DbStatus;
  select: (key: string) => void;
  updateTemplates: (mut: (t: ExpenseTemplates) => void) => void;
  updateMonth: (key: string, mut: (m: ExpenseMonth) => void) => void;
  /** Add the next month (after the latest tracked one, or the current calendar
   *  month), snapshotting the standard items. Start balance defaults to the
   *  previous month's expected end balance. */
  addMonth: () => void;
  deleteMonth: (key: string) => void;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const initial = loadLocal();

export const useExpenseStore = create<ExpenseStore>((set) => ({
  data: initial,
  selectedKey: latestKey(initial),
  dbStatus: "connecting",
  select: (key) => set({ selectedKey: key }),
  updateTemplates: (mut) =>
    set((st) => {
      const templates = clone(st.data.templates);
      mut(templates);
      const data = { ...st.data, templates };
      saveLocal(data);
      queueTemplatesSave();
      return { data };
    }),
  updateMonth: (key, mut) =>
    set((st) => {
      const months = st.data.months.map((m) => {
        if (m.key !== key) return m;
        const copy = clone(m);
        mut(copy);
        return copy;
      });
      const data = { ...st.data, months };
      saveLocal(data);
      queueMonthSave(key);
      return { data };
    }),
  addMonth: () =>
    set((st) => {
      const key = nextMonthKey(st.data, monthKeyOf(new Date()));
      if (st.data.months.some((m) => m.key === key)) return st;
      const prev = sortedMonths(st.data)[st.data.months.length - 1];
      const startBalance = prev ? round2(summariseMonth(prev).headroom) : 0;
      const month = createMonthFromTemplates(st.data.templates, key, startBalance);
      const data = { ...st.data, months: [...st.data.months, month] };
      saveLocal(data);
      void track(api.saveExpenseMonth(month));
      return { data, selectedKey: key };
    }),
  deleteMonth: (key) =>
    set((st) => {
      cancelMonthSave(key);
      const data = { ...st.data, months: st.data.months.filter((m) => m.key !== key) };
      saveLocal(data);
      void track(api.deleteExpenseMonth(key));
      const selectedKey = st.selectedKey === key ? latestKey(data) : st.selectedKey;
      return { data, selectedKey };
    }),
}));

function latestKey(d: ExpenseData): string | null {
  const months = sortedMonths(d);
  return months.length > 0 ? months[months.length - 1].key : null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function setDbStatus(status: DbStatus): void {
  if (useExpenseStore.getState().dbStatus !== status) useExpenseStore.setState({ dbStatus: status });
}

/** Fire-and-forget persistence: flip the status chip instead of interrupting the user. */
async function track<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    const v = await p;
    setDbStatus("online");
    return v;
  } catch (e) {
    console.warn("Saving to the expense database failed:", e);
    setDbStatus("offline");
    return undefined;
  }
}

// Edits arrive per keystroke; coalesce saves per month plus one slot for templates.
const pendingMonthSaves = new Map<string, ReturnType<typeof setTimeout>>();
let pendingTemplatesSave: ReturnType<typeof setTimeout> | undefined;

function queueMonthSave(key: string): void {
  clearTimeout(pendingMonthSaves.get(key));
  pendingMonthSaves.set(
    key,
    setTimeout(() => {
      pendingMonthSaves.delete(key);
      const month = useExpenseStore.getState().data.months.find((m) => m.key === key);
      if (month) void track(api.saveExpenseMonth(month));
    }, 400),
  );
}

function cancelMonthSave(key: string): void {
  clearTimeout(pendingMonthSaves.get(key));
  pendingMonthSaves.delete(key);
}

function queueTemplatesSave(): void {
  clearTimeout(pendingTemplatesSave);
  pendingTemplatesSave = setTimeout(() => {
    pendingTemplatesSave = undefined;
    void track(api.saveExpenseTemplates(useExpenseStore.getState().data.templates));
  }, 400);
}

/** After a backup restore: refresh from the database, or apply the backup's
 *  expense data locally when the restore only reached browser storage. */
export async function applyRestoredExpenses(
  fromBackup: ExpenseData | undefined,
  where: "database" | "browser-only",
): Promise<void> {
  if (where === "database") {
    await initExpensesFromDb();
  } else if (fromBackup) {
    const data = migrateExpenseData(fromBackup);
    saveLocal(data);
    useExpenseStore.setState({ data, selectedKey: latestKey(data) });
  }
}

/** Load from the database, seeding it from local data on first run. */
export async function initExpensesFromDb(): Promise<void> {
  try {
    const remote = migrateExpenseData(await api.expenses());
    const hasRemote =
      remote.months.length > 0 ||
      remote.templates.expenses.length > 0 ||
      remote.templates.income.length > 0;
    if (hasRemote) {
      saveLocal(remote);
      const st = useExpenseStore.getState();
      const selectedKey =
        st.selectedKey && remote.months.some((m) => m.key === st.selectedKey)
          ? st.selectedKey
          : latestKey(remote);
      useExpenseStore.setState({ data: remote, selectedKey, dbStatus: "online" });
    } else {
      const st = useExpenseStore.getState();
      await api.saveExpenseTemplates(st.data.templates);
      for (const m of sortedMonths(st.data)) await api.saveExpenseMonth(m);
      setDbStatus("online");
    }
  } catch (e) {
    console.warn("Expense API unreachable — using browser storage only.", e);
    setDbStatus("offline");
  }
}

if (typeof window !== "undefined") {
  void initExpensesFromDb();
  // Flush any debounced save before the tab goes away.
  window.addEventListener("pagehide", () => {
    const st = useExpenseStore.getState();
    for (const key of [...pendingMonthSaves.keys()]) {
      cancelMonthSave(key);
      const month = st.data.months.find((m) => m.key === key);
      if (month) void api.saveExpenseMonth(month, true).catch(() => undefined);
    }
    if (pendingTemplatesSave != null) {
      clearTimeout(pendingTemplatesSave);
      pendingTemplatesSave = undefined;
      void api.saveExpenseTemplates(st.data.templates, true).catch(() => undefined);
    }
  });
}
