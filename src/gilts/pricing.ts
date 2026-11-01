import type { GiltInstrument, GiltMarket, GiltPrice, GiltTerms } from "./types";
import {
  accruedPer100,
  couponPer100,
  daysBetween,
  nextCoupon,
  prevCoupon,
  yearsBetween,
} from "./schedule";

/**
 * Gilt prices and yields.
 *
 * Price ↔ yield uses the DMO's formula for conventional gilts: semi-annual compounding, the first
 * cash flow discounted by the fraction r/s of a period (days to the next coupon over days in the
 * coupon period). Settlement is taken as the trade date (the DMO's T+3 is ignored).
 *
 * Future prices: a gross-redemption-yield curve is fitted to today's near-par gilts, and each
 * gilt keeps today's spread to it (per side, so today's buy and sell prices are reproduced
 * exactly and the low-coupon tax premium persists). A gilt's yield on a later date is the curve
 * at its remaining term + its spread + the scenario's yield shift — a static curve, rolled down.
 */

export type Side = "buy" | "sell";

function monthIndex(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

/** Where settlement falls in the coupon schedule: the fraction of a period to the next coupon
 *  and how many cash flows remain (null once redeemed). Computed once per price/yield solve. */
interface FlowShape {
  frac: number;
  n: number;
}

function flowShape(terms: GiltTerms, settleIso: string): FlowShape | null {
  const next = nextCoupon(terms, settleIso);
  if (next === null) return null;
  const prev = prevCoupon(terms, settleIso);
  return {
    frac: daysBetween(settleIso, next) / daysBetween(prev, next),
    // Cash flows on the next coupon date and every six months to redemption (inclusive).
    n: Math.round((monthIndex(terms.redemptionDate) - monthIndex(next)) / 6) + 1,
  };
}

/** Present value per £100 nominal at yield `y` of the remaining cash flows: `first` on the next
 *  coupon date, `each` on every later one, and 100 at redemption. */
function presentValue(shape: FlowShape | null, y: number, first: number, each: number): number {
  if (shape === null) return 100;
  const { frac, n } = shape;
  const v = 1 / (1 + y / 2);
  // Σ_{i=1}^{n-1} each·v^i, in closed form (v = 1 at a zero yield).
  const later = n <= 1 ? 0 : Math.abs(1 - v) < 1e-12 ? each * (n - 1) : (each * v * (1 - Math.pow(v, n - 1))) / (1 - v);
  return Math.pow(v, frac) * (first + later + 100 * Math.pow(v, n - 1));
}

function solveYield(pv: (y: number) => number, price: number): number {
  let lo = -0.5;
  let hi = 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Dirty price per £100 nominal at gross redemption yield `y`, settling on `settleIso`. */
export function dirtyFromYield(terms: GiltTerms, settleIso: string, y: number, entitled = true): number {
  const c = couponPer100(terms);
  return presentValue(flowShape(terms, settleIso), y, entitled ? c : 0, c);
}

/**
 * The yield after tax of buying at `dirty` on `settleIso`: coupons net of income tax at
 * `taxRate` — the first one taxed only above the accrued interest bought with it (Accrued
 * Income Scheme) — and the redemption, whose gain over the price is CGT-free. Semi-annual, like
 * the gross redemption yield, so the two compare directly.
 */
export function netYield(
  terms: GiltTerms,
  settleIso: string,
  dirty: number,
  taxRate: number,
  accruedPaid = accruedPer100(terms, settleIso),
): number {
  const c = couponPer100(terms);
  const first = c - taxRate * Math.max(0, c - Math.max(0, accruedPaid));
  const each = c * (1 - taxRate);
  const shape = flowShape(terms, settleIso);
  return solveYield((y) => presentValue(shape, y, first, each), dirty);
}

/** Gross redemption yield from a dirty price (bisection on the monotone price–yield curve). */
export function yieldFromDirty(terms: GiltTerms, settleIso: string, dirty: number, entitled = true): number {
  const c = couponPer100(terms);
  const shape = flowShape(terms, settleIso);
  return solveYield((y) => presentValue(shape, y, entitled ? c : 0, c), dirty);
}

/** Gross redemption yield of a clean price on `iso` (cum-dividend). */
export function yieldFromClean(terms: GiltTerms, iso: string, clean: number): number {
  return yieldFromDirty(terms, iso, clean + accruedPer100(terms, iso));
}

/** Clean price per £100 at yield `y` on `iso` (cum-dividend). */
export function cleanFromYield(terms: GiltTerms, iso: string, y: number): number {
  if (iso >= terms.redemptionDate) return 100;
  return dirtyFromYield(terms, iso, y) - accruedPer100(terms, iso);
}

// ---------------------------------------------------------------------------------------------
// The yield curve.

const KNOTS = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50];

export interface YieldCurve {
  terms: number[];
  yields: number[];
}

/** A smooth curve through (term, yield) points: each knot is a kernel-weighted mean of the
 *  points near it; linear between knots, flat beyond the ends. */
export function fitCurve(points: { term: number; y: number }[]): YieldCurve {
  const terms: number[] = [];
  const yields: number[] = [];
  for (const k of KNOTS) {
    const bw = Math.max(0.5, k * 0.25);
    let sw = 0;
    let swy = 0;
    for (const p of points) {
      const w = Math.exp(-(((p.term - k) / bw) ** 2));
      sw += w;
      swy += w * p.y;
    }
    if (sw > 1e-3) {
      terms.push(k);
      yields.push(swy / sw);
    }
  }
  if (terms.length === 0 && points.length > 0) {
    // Too sparse for the kernel: use the points themselves.
    const sorted = [...points].sort((a, b) => a.term - b.term);
    for (const p of sorted) {
      terms.push(p.term);
      yields.push(p.y);
    }
  }
  return { terms, yields };
}

export function curveAt(curve: YieldCurve, term: number): number | null {
  const { terms, yields } = curve;
  if (terms.length === 0) return null;
  if (term <= terms[0]) return yields[0];
  const last = terms.length - 1;
  if (term >= terms[last]) return yields[last];
  let i = 1;
  while (terms[i] < term) i++;
  const t = (term - terms[i - 1]) / (terms[i] - terms[i - 1]);
  return yields[i - 1] + t * (yields[i] - yields[i - 1]);
}

// ---------------------------------------------------------------------------------------------
// Pricing a market.

/** Recorded prices count as "actual" for a date within this many days after them. */
const OBSERVED_WINDOW_DAYS = 10;

export interface GiltPricing {
  /** False when there are no prices at all: every gilt is valued at par. */
  readonly hasMarket: boolean;
  readonly asOf: string | null;
  /** Whether the market knows this ISIN (has a price for it). */
  knows(isin: string): boolean;
  /** Clean price per £100: the DMO price on or shortly before `iso` if recorded, else modelled. */
  clean(isin: string, terms: GiltTerms, iso: string, side: Side): number;
  /** Clean price plus accrued interest (cum-dividend) per £100. */
  dirty(isin: string, terms: GiltTerms, iso: string, side: Side): number;
  /** The recorded DMO clean price on or within ten days before `iso`, or null. */
  observed(isin: string, iso: string, side: Side): number | null;
  /** The fitted curve's gross yield at a term in years (null with no market). */
  curveYield(term: number): number | null;
  /** Today's (asOf) gross redemption yield of a gilt on one side, or null if unpriced. */
  yieldOf(isin: string, side: Side): number | null;
}

const PAR: GiltPricing = {
  hasMarket: false,
  asOf: null,
  knows: () => false,
  clean: () => 100,
  dirty: (_isin, terms, iso) => 100 + accruedPer100(terms, iso),
  observed: () => null,
  curveYield: () => null,
  yieldOf: () => null,
};

function latestPrices(market: GiltMarket): Map<string, GiltPrice> {
  const out = new Map<string, GiltPrice>();
  for (const p of market.prices) {
    if (market.asOf !== null && p.priceDate > market.asOf) continue;
    const cur = out.get(p.isin);
    if (!cur || p.priceDate > cur.priceDate) out.set(p.isin, p);
  }
  return out;
}

function build(market: GiltMarket, shift: number): GiltPricing {
  if (market.prices.length === 0 || market.asOf === null) return PAR;
  const asOf = market.asOf;
  const instruments = new Map<string, GiltInstrument>();
  for (const i of market.instruments) instruments.set(i.isin, i);

  const history = new Map<string, GiltPrice[]>();
  for (const p of market.prices) {
    const list = history.get(p.isin) ?? [];
    list.push(p);
    history.set(p.isin, list);
  }
  for (const list of history.values()) list.sort((a, b) => (a.priceDate < b.priceDate ? -1 : 1));

  // Today's yields, and the curve through the near-par conventionals.
  const latest = latestPrices(market);
  const yields = new Map<string, { buy: number; sell: number; mid: number; term: number; clean: number }>();
  for (const [isin, p] of latest) {
    const inst = instruments.get(isin);
    if (!inst || inst.indexLinked || p.priceDate !== asOf) continue;
    if (inst.redemptionDate <= asOf) continue;
    const mid = (p.buyClean + p.sellClean) / 2;
    yields.set(isin, {
      buy: yieldFromClean(inst, asOf, p.buyClean),
      sell: yieldFromClean(inst, asOf, p.sellClean),
      mid: yieldFromClean(inst, asOf, mid),
      term: yearsBetween(asOf, inst.redemptionDate),
      clean: mid,
    });
  }
  const eligible = (strict: boolean) =>
    [...yields.entries()]
      .filter(([isin, y]) => {
        const inst = instruments.get(isin)!;
        return !inst.rump && y.term >= 0.25 && (!strict || Math.abs(y.clean - 100) <= 10);
      })
      .map(([, y]) => ({ term: y.term, y: y.mid }));
  let points = eligible(true);
  if (points.length < 3) points = eligible(false);
  const curve = fitCurve(points);
  if (curve.terms.length === 0) return PAR;
  const curveYield = (term: number) => curveAt(curve, term);

  const spreads = new Map<string, Record<Side, number>>();
  for (const [isin, y] of yields) {
    const c = curveYield(y.term)!;
    spreads.set(isin, { buy: y.buy - c, sell: y.sell - c });
  }

  const observed = (isin: string, iso: string, side: Side): number | null => {
    const list = history.get(isin);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (list[m].priceDate <= iso) {
        found = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    if (found < 0) return null;
    const p = list[found];
    if (daysBetween(p.priceDate, iso) > OBSERVED_WINDOW_DAYS) return null;
    return side === "buy" ? p.buyClean : p.sellClean;
  };

  const cache = new Map<string, number>();
  const clean = (isin: string, terms: GiltTerms, iso: string, side: Side): number => {
    if (iso >= terms.redemptionDate) return 100;
    const key = `${isin}|${side}|${iso}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let price = observed(isin, iso, side);
    if (price === null) {
      const y = curveYield(yearsBetween(iso, terms.redemptionDate))! + shift + (spreads.get(isin)?.[side] ?? 0);
      price = cleanFromYield(terms, iso, y);
    }
    cache.set(key, price);
    return price;
  };

  const dirtyCache = new Map<string, number>();
  return {
    hasMarket: true,
    asOf,
    knows: (isin) => history.has(isin),
    clean,
    dirty: (isin, terms, iso, side) => {
      const key = `${isin}|${side}|${iso}`;
      let d = dirtyCache.get(key);
      if (d === undefined) {
        d = clean(isin, terms, iso, side) + accruedPer100(terms, iso);
        dirtyCache.set(key, d);
      }
      return d;
    },
    observed,
    curveYield,
    yieldOf: (isin, side) => yields.get(isin)?.[side] ?? null,
  };
}

const memo = new WeakMap<GiltMarket, Map<number, GiltPricing>>();

/** Pricing for a market (memoised per market object and yield shift, so the optimiser's many
 *  simulate runs share one instance and its price cache). No market → everything at par. */
export function buildPricing(market: GiltMarket | null | undefined, shift = 0): GiltPricing {
  if (!market) return PAR;
  let byShift = memo.get(market);
  if (!byShift) {
    byShift = new Map();
    memo.set(market, byShift);
  }
  let p = byShift.get(shift);
  if (!p) {
    p = build(market, shift);
    byShift.set(shift, p);
  }
  return p;
}
