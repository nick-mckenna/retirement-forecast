import { create } from "zustand";
import { api } from "../api/client";
import type { GiltMarket } from "../gilts/types";
import { missingPriceDates, neededPriceDates } from "../gilts/market";
import { previousBusinessDay } from "../gilts/schedule";
import { usePreRetirementStore } from "./preRetirementStore";

// The gilt market (public DMO data). The server fetches it from the DMO and caches it in the
// database; this store mirrors it, with localStorage as an offline cache. Unlike the other
// stores nothing is ever saved from here — refreshing is the only write, and it is the server's.
//
// Refreshes: on startup when the latest prices are older than the previous business day (at
// most once an hour), whenever held gilts need prices for past dates the cache lacks, and on
// demand (the Refresh button).

const LS_KEY = "retirement-forecast:gilts";
const LS_ATTEMPT = "retirement-forecast:gilts:lastAttempt";
const AUTO_INTERVAL_MS = 60 * 60 * 1000;

export type GiltMarketStatus = "idle" | "loading" | "refreshing" | "error";

interface GiltMarketStore {
  market: GiltMarket | null;
  status: GiltMarketStatus;
  /** The last refresh's problem, if any (shown next to the Refresh button). */
  error: string | null;
  /** Fetch the latest DMO prices now (and any missing history for held gilts). */
  refresh: () => Promise<void>;
}

/** Today in the UK, ISO (the DMO publishes UK business days). */
export function ukToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

function loadLocal(): GiltMarket | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as GiltMarket;
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return null;
}

function saveLocal(m: GiltMarket): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m));
  } catch {
    /* storage may be unavailable or full */
  }
}

function heldIsins(): string[] {
  return neededPriceDates(usePreRetirementStore.getState().data, ukToday()).isins;
}

/** The held ISINs the loaded market has history for. */
let loadedFor = "";

async function reload(): Promise<void> {
  const isins = heldIsins();
  const market = await api.gilts(isins);
  loadedFor = isins.join(",");
  saveLocal(market);
  useGiltMarketStore.setState({ market });
}

/** Dates already asked of the server this session (so a date the DMO can't serve isn't
 *  re-requested on every edit). */
const requested = new Set<string>();

async function runRefresh(dates: string[]): Promise<void> {
  useGiltMarketStore.setState({ status: "refreshing", error: null });
  try {
    for (const d of dates) requested.add(d);
    const r = await api.refreshGilts(dates);
    await reload();
    useGiltMarketStore.setState({
      status: "idle",
      error: r.errors.length > 0 ? `Some past prices could not be fetched (${r.errors.length})` : null,
    });
  } catch (e) {
    useGiltMarketStore.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export const useGiltMarketStore = create<GiltMarketStore>()(() => ({
  market: loadLocal(),
  status: "idle",
  error: null,
  refresh: () => manualRefresh(),
}));

function manualRefresh(): Promise<void> {
  const st = useGiltMarketStore.getState();
  return runRefresh(missingPriceDates(st.market, usePreRetirementStore.getState().data, ukToday()));
}

function isStale(m: GiltMarket | null): boolean {
  return !m || m.asOf === null || m.asOf < previousBusinessDay(ukToday());
}

function dueAutoAttempt(): boolean {
  try {
    const last = Number(localStorage.getItem(LS_ATTEMPT) ?? 0);
    if (Date.now() - last < AUTO_INTERVAL_MS) return false;
    localStorage.setItem(LS_ATTEMPT, String(Date.now()));
  } catch {
    /* storage unavailable: just try */
  }
  return true;
}

let ensureTimer: ReturnType<typeof setTimeout> | undefined;

/** Fetch past prices that held gilts need and the cache lacks (debounced, once per date). */
function ensureHistory(): void {
  clearTimeout(ensureTimer);
  ensureTimer = setTimeout(async () => {
    if (useGiltMarketStore.getState().status === "refreshing" || useGiltMarketStore.getState().status === "loading") return;
    // A newly held gilt: the server may already have its history.
    if (heldIsins().join(",") !== loadedFor) await reload().catch(() => undefined);
    const st = useGiltMarketStore.getState();
    const missing = missingPriceDates(st.market, usePreRetirementStore.getState().data, ukToday()).filter(
      (d) => !requested.has(d),
    );
    if (missing.length > 0) void runRefresh(missing);
  }, 1500);
}

async function init(): Promise<void> {
  useGiltMarketStore.setState({ status: "loading" });
  try {
    await reload();
    useGiltMarketStore.setState({ status: "idle" });
  } catch (e) {
    // API down: keep whatever is cached locally.
    useGiltMarketStore.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (isStale(useGiltMarketStore.getState().market) && dueAutoAttempt()) await useGiltMarketStore.getState().refresh();
  else ensureHistory();
}

if (typeof window !== "undefined") {
  void init();
  let lastLots = usePreRetirementStore.getState().data.giltLots;
  let lastOpening = usePreRetirementStore.getState().data.openingMonth;
  usePreRetirementStore.subscribe((st) => {
    if (st.data.giltLots === lastLots && st.data.openingMonth === lastOpening) return;
    lastLots = st.data.giltLots;
    lastOpening = st.data.openingMonth;
    ensureHistory();
  });
}
