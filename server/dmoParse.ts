import type { GiltInstrument, GiltPrice } from "../src/gilts/types";
import type { XlsCell } from "./xls";

/**
 * Parsers for the DMO's report exports, working on the cell grids `readXls` returns. Pure, so
 * they are tested with synthetic grids. They locate columns by their header text and fail
 * loudly when the expected headers are missing — a DMO layout change then surfaces as a refresh
 * error rather than wrong prices.
 *
 * D1A  "Gilts in issue": name (the coupon is only in the name), ISIN, redemption date, first issue
 *      date, dividend dates ("7 Jun/Dec"), ex-dividend date, amount in issue — a conventional
 *      section (with "Short"/"Medium"/... sub-headings) and an index-linked section.
 * D10B "DMO gilt purchase and sale service prices": ISIN, name, purchase/sale clean and dirty
 *      prices, index ratio, redemption date, rump flag.
 */

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const FRACTIONS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const text = (v: XlsCell | undefined): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

function num(v: XlsCell | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Excel serial date (1900 system) → ISO. */
export function excelSerialToIso(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

/** The annual coupon (decimal) from a gilt name: "4 1/8% Treasury Gilt 2027" → 0.04125,
 *  "3¾% …" → 0.0375, "1¼ % …" → 0.0125, "0⅞% …" → 0.00875. Null if there is none. */
export function parseCoupon(name: string): number | null {
  const m = /^\s*(\d+)?\s*([¼½¾⅛⅜⅝⅞]|\d+\/\d+)?\s*%/.exec(name);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  let pct = m[1] !== undefined ? Number(m[1]) : 0;
  const frac = m[2];
  if (frac !== undefined) {
    if (frac in FRACTIONS) pct += FRACTIONS[frac];
    else {
      const [a, b] = frac.split("/").map(Number);
      if (!b) return null;
      pct += a / b;
    }
  }
  return Math.round(pct * 1e6) / 1e8;
}

/** "29 Jan/Jul" → { day: 29, months: [0, 6] } (0-based months), or null. */
export function parseDividendDates(s: string): { day: number; months: number[] } | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s*\/\s*([A-Za-z]{3})/.exec(s.trim());
  if (!m) return null;
  const months = [m[2], m[3]].map((x) => MONTHS.indexOf(x.toLowerCase()));
  if (months.some((x) => x < 0)) return null;
  return { day: Number(m[1]), months };
}

/** "30 October 2026" or "… ON 30 OCTOBER 2026" → ISO, or null. */
export function parseLongDate(s: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString().slice(0, 10);
}

/** A report for a date with no data (a bank holiday, say) is still a workbook — headers and a
 *  "No information to display" row — rather than the "Unable to fulfil" text. */
export function isNoDataReport(rows: XlsCell[][]): boolean {
  return rows.some((row) => row?.some((c) => /no information to display/i.test(text(c))));
}

function findCol(header: XlsCell[], re: RegExp): number {
  return header.findIndex((h) => re.test(text(h)));
}

function reportDate(rows: XlsCell[][]): string | null {
  for (const row of rows.slice(0, 4))
    for (const c of row ?? []) {
      const d = parseLongDate(text(c));
      if (d) return d;
    }
  return null;
}

export interface D1AResult {
  /** The report's "gilts in issue on" date, if stated. */
  reportDate: string | null;
  instruments: GiltInstrument[];
  /** Rows that parsed but look inconsistent (coupon dates not matching the redemption date). */
  warnings: string[];
}

export function parseD1A(rows: XlsCell[][]): D1AResult {
  const instruments: GiltInstrument[] = [];
  const warnings: string[] = [];
  let cols: { isin: number; redemption: number; dividends: number } | null = null;
  let indexLinked = false;
  let sawConventionalHeader = false;

  for (const row of rows) {
    if (!row) continue;
    const isinCol = findCol(row, /^ISIN/i);
    if (isinCol >= 0 && !ISIN.test(text(row[isinCol]))) {
      // A section header row.
      indexLinked = /index-linked/i.test(text(row[0]));
      if (!indexLinked && /conventional/i.test(text(row[0]))) sawConventionalHeader = true;
      cols = { isin: isinCol, redemption: findCol(row, /^Redemption/i), dividends: findCol(row, /^Dividend Dates/i) };
      if (cols.redemption < 0) throw new Error("D1A: no Redemption Date column");
      continue;
    }
    if (!cols) continue;
    const isin = text(row[cols.isin]);
    if (!ISIN.test(isin)) continue; // sub-headings ("Short", "Medium", ...) and notes
    const name = text(row[0]);
    const serial = num(row[cols.redemption]);
    const couponRate = parseCoupon(name);
    if (serial === null || couponRate === null) {
      warnings.push(`D1A: skipped ${isin} "${name}" (no coupon or redemption date)`);
      continue;
    }
    const redemptionDate = excelSerialToIso(serial);
    if (cols.dividends >= 0) {
      const dd = parseDividendDates(text(row[cols.dividends]));
      const redMonth = Number(redemptionDate.slice(5, 7)) - 1;
      if (dd && (!dd.months.includes(redMonth) || dd.day !== Number(redemptionDate.slice(8, 10))))
        warnings.push(`D1A: ${name} pays coupons on "${text(row[cols.dividends])}", not its redemption day`);
    }
    instruments.push({ isin, name, couponRate, redemptionDate, indexLinked, rump: false });
  }
  if (!sawConventionalHeader || !instruments.some((i) => !i.indexLinked))
    throw new Error("D1A: no conventional gilts found — has the report layout changed?");
  return { reportDate: reportDate(rows), instruments, warnings };
}

export interface D10BResult {
  /** The trade date the report states, if any. */
  reportDate: string | null;
  /** Conventional gilts' prices (index-linked rows are skipped: their prices need the index
   *  ratio and they are not modelled). */
  prices: Omit<GiltPrice, "priceDate">[];
  /** ISINs flagged as rump gilts. */
  rump: string[];
}

export function parseD10B(rows: XlsCell[][]): D10BResult {
  const headerIdx = rows.findIndex((r) => r && findCol(r, /^ISIN/i) >= 0 && findCol(r, /clean price/i) >= 0);
  if (headerIdx < 0) throw new Error("D10B: no price header row — has the report layout changed?");
  const h = rows[headerIdx];
  const col = {
    isin: findCol(h, /^ISIN/i),
    name: findCol(h, /name/i),
    buyClean: findCol(h, /^Purchase.*Clean/i),
    buyDirty: findCol(h, /^Purchase.*Dirty/i),
    sellClean: findCol(h, /^Sale.*Clean/i),
    sellDirty: findCol(h, /^Sale.*Dirty/i),
    indexRatio: findCol(h, /Index Ratio/i),
    rump: findCol(h, /Rump/i),
  };
  for (const [k, v] of Object.entries(col))
    if (v < 0 && k !== "indexRatio" && k !== "rump") throw new Error(`D10B: no ${k} column`);

  const prices: Omit<GiltPrice, "priceDate">[] = [];
  const rump: string[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    if (!row) continue;
    const isin = text(row[col.isin]);
    if (!ISIN.test(isin)) continue;
    const name = text(row[col.name]);
    const indexLinked = /index-linked/i.test(name) || (col.indexRatio >= 0 && num(row[col.indexRatio]) !== null);
    if (col.rump >= 0 && /^y/i.test(text(row[col.rump]))) rump.push(isin);
    if (indexLinked) continue;
    const buyClean = num(row[col.buyClean]);
    const sellClean = num(row[col.sellClean]);
    if (buyClean === null || sellClean === null || buyClean <= 0 || sellClean <= 0) continue;
    prices.push({
      isin,
      buyClean,
      buyDirty: num(row[col.buyDirty]) ?? buyClean,
      sellClean,
      sellDirty: num(row[col.sellDirty]) ?? sellClean,
    });
  }
  if (prices.length === 0) throw new Error("D10B: no prices found — has the report layout changed?");
  return { reportDate: reportDate(rows), prices, rump };
}
