import { parseDate, taxYearStartYear, toIso } from "../tax/taxYear";
import type { GiltTerms } from "./types";

/**
 * Coupon schedule of a conventional gilt, derived from its redemption date: coupons are half the
 * annual rate, paid on the redemption day-of-month every six months up to and including the
 * redemption date (the day clamped to the month's length). Irregular first coupons of brand-new
 * issues are ignored. All dates are ISO strings; comparisons are lexical.
 */

const DAY_MS = 86_400_000;

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The coupon date of a gilt in a given month (month0 = 0..11), whether or not one falls there. */
function couponDateIn(terms: GiltTerms, year: number, month0: number): string {
  const day = Number(terms.redemptionDate.slice(8, 10));
  return toIso(new Date(Date.UTC(year, month0, Math.min(day, daysInMonth(year, month0)))));
}

function isCouponMonth(terms: GiltTerms, month0: number): boolean {
  const redMonth0 = Number(terms.redemptionDate.slice(5, 7)) - 1;
  return (((month0 - redMonth0) % 6) + 6) % 6 === 0;
}

export function daysBetween(fromIso: string, toIsoDate: string): number {
  return Math.round((parseDate(toIsoDate).getTime() - parseDate(fromIso).getTime()) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return toIso(new Date(parseDate(iso).getTime() + days * DAY_MS));
}

/** Years from one date to another (actual days / 365.25). */
export function yearsBetween(fromIso: string, toIsoDate: string): number {
  return daysBetween(fromIso, toIsoDate) / 365.25;
}

/** The latest coupon date on or before `iso` (the schedule is extended backwards indefinitely). */
export function prevCoupon(terms: GiltTerms, iso: string): string {
  const d = parseDate(iso);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (let i = 0; i < 13; i++) {
    if (isCouponMonth(terms, m)) {
      const c = couponDateIn(terms, y, m);
      if (c <= iso) return c;
    }
    m--;
    if (m < 0) {
      m = 11;
      y--;
    }
  }
  throw new Error(`no coupon date found before ${iso}`);
}

/** The first coupon date strictly after `iso`, or null once the gilt has redeemed. */
export function nextCoupon(terms: GiltTerms, iso: string): string | null {
  if (iso >= terms.redemptionDate) return null;
  const d = parseDate(iso);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (let i = 0; i < 13; i++) {
    if (isCouponMonth(terms, m)) {
      const c = couponDateIn(terms, y, m);
      if (c > iso) return c;
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  throw new Error(`no coupon date found after ${iso}`);
}

/** Coupon dates in (fromExcl, toIncl], never after redemption. */
export function couponsBetween(terms: GiltTerms, fromExcl: string, toIncl: string): string[] {
  const out: string[] = [];
  let c = nextCoupon(terms, fromExcl);
  while (c !== null && c <= toIncl) {
    out.push(c);
    c = nextCoupon(terms, c);
  }
  return out;
}

/** Coupon dates from the first after `fromExcl` up to and including redemption. */
export function remainingCoupons(terms: GiltTerms, fromExcl: string): string[] {
  return couponsBetween(terms, fromExcl, terms.redemptionDate);
}

/** The coupon paid on each coupon date per £100 nominal. */
export function couponPer100(terms: GiltTerms): number {
  return (terms.couponRate * 100) / 2;
}

/** Gilts go ex-dividend seven business days before a coupon (weekends skipped; bank holidays
 *  ignored): whoever holds the gilt at the start of that day is the one paid. */
export function exDivDate(couponIso: string): string {
  let d = parseDate(couponIso);
  let left = 7;
  while (left > 0) {
    d = new Date(d.getTime() - DAY_MS);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return toIso(d);
}

/** True when a purchase settling on `iso` still receives the next coupon. */
export function entitledToNextCoupon(terms: GiltTerms, iso: string): boolean {
  const next = nextCoupon(terms, iso);
  return next === null || iso < exDivDate(next);
}

/**
 * Accrued interest per £100 nominal on `iso` (actual/actual within the half-year period). When
 * the holder is not entitled to the next coupon (ex-dividend) it is negative: the buyer is paid
 * for the days until the coupon that goes to the seller.
 */
export function accruedPer100(terms: GiltTerms, iso: string, entitled = true): number {
  const next = nextCoupon(terms, iso);
  if (next === null) return 0;
  const prev = prevCoupon(terms, iso);
  const period = daysBetween(prev, next);
  const c = couponPer100(terms);
  return entitled
    ? (c * daysBetween(prev, iso)) / period
    : (-c * daysBetween(iso, next)) / period;
}

/**
 * The tax year whose spending a gilt redeeming on this date funds: the one whose 6 April is the
 * first on or after redemption (6 Apr 2030 → 2030; 7 Jun 2027 → 2028). The engine's fictional
 * gilts redeem on 6 April, so for them this is the redemption year.
 */
export function fundsYear(redemptionIso: string): number {
  return taxYearStartYear(parseDate(addDays(redemptionIso, -1))) + 1;
}

/** Last day of the calendar month of `monthKey` ("yyyy-mm"). */
export function monthEnd(monthKey: string): string {
  const y = Number(monthKey.slice(0, 4));
  const m0 = Number(monthKey.slice(5, 7)) - 1;
  return toIso(new Date(Date.UTC(y, m0, daysInMonth(y, m0))));
}

/** The latest weekday on or before `iso` (bank holidays aren't known here; the DMO fetch walks
 *  back further when a weekday has no prices). */
export function lastBusinessDay(iso: string): string {
  let d = parseDate(iso);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() - DAY_MS);
  return toIso(d);
}

/** The weekday before `iso`. */
export function previousBusinessDay(iso: string): string {
  return lastBusinessDay(addDays(iso, -1));
}
