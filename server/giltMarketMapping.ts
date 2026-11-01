// Pure mapping between the gilt-market domain objects and their SQL rows. No DB or Node
// dependencies, so src/__tests__/giltMarketMapping.test.ts can guard the round trip.
//
// The market is public, re-fetchable data (DMO reports), not user data: it is cached in the
// database for offline use and price history, and deliberately left out of backups.

import type { GiltInstrument, GiltPrice } from "../src/gilts/types";

type SqlNum = number | string;
type SqlBool = boolean | number | string;
/** DATE columns come back from the driver as Date objects (UTC midnight). */
type SqlDate = Date | string;

function num(v: SqlNum): number {
  return typeof v === "number" ? v : Number(v);
}

function bool(v: SqlBool): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function iso(v: SqlDate): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export interface GiltInstrumentRow {
  isin: string;
  name: string;
  couponRate: SqlNum;
  redemptionDate: SqlDate;
  indexLinked: SqlBool;
  rump: SqlBool;
}

export interface GiltPriceRow {
  isin: string;
  priceDate: SqlDate;
  buyClean: SqlNum;
  buyDirty: SqlNum;
  sellClean: SqlNum;
  sellDirty: SqlNum;
}

export function instrumentToRow(i: GiltInstrument): GiltInstrumentRow {
  return {
    isin: i.isin,
    name: i.name,
    couponRate: i.couponRate,
    redemptionDate: i.redemptionDate,
    indexLinked: i.indexLinked,
    rump: i.rump,
  };
}

export function rowToInstrument(r: GiltInstrumentRow): GiltInstrument {
  return {
    isin: r.isin,
    name: r.name,
    couponRate: num(r.couponRate),
    redemptionDate: iso(r.redemptionDate),
    indexLinked: bool(r.indexLinked),
    rump: bool(r.rump),
  };
}

export function priceToRow(p: GiltPrice): GiltPriceRow {
  return {
    isin: p.isin,
    priceDate: p.priceDate,
    buyClean: p.buyClean,
    buyDirty: p.buyDirty,
    sellClean: p.sellClean,
    sellDirty: p.sellDirty,
  };
}

export function rowToPrice(r: GiltPriceRow): GiltPrice {
  return {
    isin: r.isin,
    priceDate: iso(r.priceDate),
    buyClean: num(r.buyClean),
    buyDirty: num(r.buyDirty),
    sellClean: num(r.sellClean),
    sellDirty: num(r.sellDirty),
  };
}
