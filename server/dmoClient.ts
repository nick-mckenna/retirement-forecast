// Fetches the UK Debt Management Office's public gilt reports and caches them in the database.
//
// This is the app's only outbound network call: plain HTTPS GETs of public data from
// www.dmo.gov.uk, made by the local server (browsers can't fetch it cross-origin). Nothing about
// the user is sent. Reports are only offered as legacy .xls, read by ./xls.ts.
//
//   D1A  gilts in issue on a close-of-business date   (parameter "COBDate")
//   D10B purchase & sale service prices for a trade date (parameter "Trade Date")
//
// A date with no data (weekend, bank holiday, not yet published) returns the text "Unable to
// fulfil the report request", or a workbook saying "No information to display"; we then step
// back a business day.

import { sql } from "./db";
import { isOle2, readXls, type XlsCell } from "./xls";
import { isNoDataReport, parseD10B, parseD1A } from "./dmoParse";
import { hasPricesNear, latestPriceDate, replacePrices, upsertInstruments } from "./giltMarketRepo";
import { lastBusinessDay, previousBusinessDay } from "../src/gilts/schedule";
import type { GiltPrice } from "../src/gilts/types";

const BASE = "https://www.dmo.gov.uk/umbraco/surface/DataExport/GetDataExport";
const MAX_STEPS_BACK = 7;
/** At most this many historical dates per refresh (each is one or more HTTP requests). */
const MAX_HISTORY_DATES = 60;

type Report = "D1A" | "D10B";

export function dmoUrl(report: Report, isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const param = report === "D1A" ? `&COBDate=${d}/${m}/${y}` : `&Trade Date=${d}/${m}/${y}`;
  return `${BASE}?reportCode=${report}&exportFormatValue=xls&parameters=${encodeURIComponent(param)}`;
}

/** Today's date in the UK, ISO. */
export function londonToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

/** One report for one date: the first sheet's cells, or null when the DMO has no data then. */
async function fetchReport(report: Report, isoDate: string): Promise<XlsCell[][] | null> {
  const res = await fetch(dmoUrl(report, isoDate), {
    headers: { "User-Agent": "retirement-forecast (personal finance planner)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DMO ${report} ${isoDate}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isOle2(bytes)) {
    const sheet = readXls(bytes).sheets[0];
    if (!sheet) throw new Error(`DMO ${report} ${isoDate}: empty workbook`);
    return isNoDataReport(sheet.rows) ? null : sheet.rows;
  }
  const body = new TextDecoder().decode(bytes.subarray(0, 500));
  if (/unable to fulfil/i.test(body)) return null;
  throw new Error(`DMO ${report} ${isoDate}: unexpected response "${body.slice(0, 80)}"`);
}

/** The report for the latest business day on or before `isoDate` that has data. */
export async function fetchOnOrBefore(report: Report, isoDate: string): Promise<{ date: string; rows: XlsCell[][] }> {
  let date = lastBusinessDay(isoDate);
  for (let step = 0; step <= MAX_STEPS_BACK; step++) {
    const rows = await fetchReport(report, date);
    if (rows) return { date, rows };
    date = previousBusinessDay(date);
  }
  throw new Error(`DMO ${report}: no data within ${MAX_STEPS_BACK} business days before ${isoDate}`);
}

async function storePrices(pool: sql.ConnectionPool, onOrBefore: string): Promise<{ date: string; rump: string[] }> {
  const { date, rows } = await fetchOnOrBefore("D10B", onOrBefore);
  const parsed = parseD10B(rows);
  const priceDate = parsed.reportDate ?? date;
  const prices: GiltPrice[] = parsed.prices.map((p) => ({ ...p, priceDate }));
  await replacePrices(pool, priceDate, prices);
  return { date: priceDate, rump: parsed.rump };
}

export interface RefreshResult {
  /** Date of the latest prices now stored (null if none). */
  asOf: string | null;
  /** Trade dates fetched by this refresh. */
  fetched: string[];
  /** Problems with individual historical dates (the latest prices failing throws instead). */
  errors: string[];
}

async function doRefresh(pool: sql.ConnectionPool, dates: string[]): Promise<RefreshResult> {
  const today = londonToday();
  const fetched: string[] = [];
  const errors: string[] = [];

  // Latest prices (and the list of gilts in issue that goes with them).
  const stored = await latestPriceDate(pool);
  if (stored === null || stored < lastBusinessDay(today)) {
    const latest = await storePrices(pool, today);
    if (latest.date !== stored) {
      const d1a = await fetchOnOrBefore("D1A", latest.date);
      const parsed = parseD1A(d1a.rows);
      for (const w of parsed.warnings) console.warn(w);
      const rump = new Set(latest.rump);
      await upsertInstruments(pool, parsed.instruments.map((i) => ({ ...i, rump: rump.has(i.isin) })));
      fetched.push(latest.date);
    }
  }

  // Historical prices for valuing the user's gilts at past dates.
  const wanted = [...new Set(dates)].filter((d) => d <= today).sort().reverse().slice(0, MAX_HISTORY_DATES);
  for (const d of wanted) {
    if (await hasPricesNear(pool, d, MAX_STEPS_BACK + 3)) continue;
    try {
      const got = await storePrices(pool, d);
      fetched.push(got.date);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { asOf: await latestPriceDate(pool), fetched, errors };
}

let queue: Promise<unknown> = Promise.resolve();

/** Fetch whatever isn't cached yet: the latest prices (if older than the last business day) and
 *  any requested historical dates. Refreshes run one at a time. */
export function refreshMarket(pool: sql.ConnectionPool, dates: string[]): Promise<RefreshResult> {
  const run = queue.then(() => doRefresh(pool, dates));
  queue = run.catch(() => undefined);
  return run;
}
