import type { PersonId, StrategyConfig, TaxYearParams } from "../model/types";
import type { SimState } from "../engine/state";
import { LUMP_SUM_ALLOWANCE, lsaUsedBy, pensionGrossForTaxable } from "../tax/pensionDraw";
import { personYearTax } from "../tax/personTax";

export type Source = "pension" | "gia" | "gilt" | "isa";
/** Sources the marginal optimiser can draw from (gilts are the buffer, not a raise source). */
export type SellSource = "isa" | "pension" | "gia";

export interface Withdrawal {
  person: PersonId;
  source: Source;
  /** Amount removed from the source pot. */
  gross: number;
  /** Taxable non-savings income created (pension: 75% of gross while the Lump Sum Allowance
   *  lasts, all of it after). */
  taxableNonSavings: number;
  /** Capital gain realised (GIA only; gilts are CGT-exempt). */
  realisedGain: number;
  /** Tax-free pension cash used out of the Lump Sum Allowance (pension only). */
  lsaUsed: number;
  decisionKey: string;
}

interface PersonPlan {
  person: PersonId;
  pensionAccessible: boolean;
  /** Running non-savings taxable income (state pension etc.) used to place band room. */
  runningNonSavings: number;
  /** The year's savings income and dividends. They are taxed on top of non-savings income,
   *  so they occupy the top of the bands: pension drawn "within a band" must leave room for them. */
  otherIncome: number;
  /** The same, split by type — the exact pricing taxes them at their own rates. */
  savings: number;
  dividends: number;
  /** Capital gains realised so far this year, including those the plan adds. */
  runningGain: number;
  cgtAllowanceRemaining: number;
  gainFraction: number;
  /** Lump Sum Allowance left as the plan draws pension. */
  lsaRemaining: number;
  p: TaxYearParams;
}

interface Step {
  person: PersonId;
  source: Source;
  /** Lower is preferred. */
  priority: number;
  /** Estimate the max gross available from this step given the plan's running state. */
  available: (plan: PersonPlan, state: SimState) => number;
  /** Apply the taken gross to the plan's running state and return the taxable/gain effect. */
  effect: (
    plan: PersonPlan,
    gross: number,
  ) => { taxableNonSavings: number; realisedGain: number; lsaUsed: number };
}

/** Band-top draws stop this far inside the band. The personal savings allowance drops at a
 *  cliff edge just past the basic- and higher-rate tops (£1,000 → £500 → £0), so landing exactly
 *  on a top leaves the result to floating-point noise; £1 of headroom costs at most 20p. */
const BAND_MARGIN = 1;

function pensionWithinBand(bandTop: number, netOfOtherIncome: boolean) {
  return (plan: PersonPlan, state: SimState) => {
    if (!plan.pensionAccessible) return 0;
    const pot = state.balances[plan.person].pension;
    if (pot <= 0) return 0;
    // Keep the taxable part within the band top (75% of the gross while the Lump Sum Allowance
    // lasts, all of it after). Above the personal allowance the year's savings and dividends
    // stack on top, so they use up band room too.
    const top = netOfOtherIncome ? bandTop - plan.otherIncome - BAND_MARGIN : bandTop;
    const taxableRoom = Math.max(0, top - plan.runningNonSavings);
    return Math.min(pot, pensionGrossForTaxable(taxableRoom, plan.lsaRemaining));
  };
}

function pensionEffect(plan: PersonPlan, gross: number) {
  const lsaUsed = lsaUsedBy(gross, plan.lsaRemaining);
  const taxable = gross - lsaUsed;
  plan.lsaRemaining -= lsaUsed;
  plan.runningNonSavings += taxable;
  return { taxableNonSavings: taxable, realisedGain: 0, lsaUsed };
}

function giaWithinCgtAllowance() {
  return (plan: PersonPlan, state: SimState) => {
    const gia = state.balances[plan.person].gia;
    if (gia <= 0 || plan.gainFraction <= 0) return gia > 0 ? gia : 0;
    if (plan.cgtAllowanceRemaining <= 0) return 0;
    return Math.min(gia, plan.cgtAllowanceRemaining / plan.gainFraction);
  };
}

function giaAny() {
  return (_plan: PersonPlan, state: SimState) => state.balances[_plan.person].gia;
}

function giaEffect(plan: PersonPlan, gross: number) {
  const gain = gross * plan.gainFraction;
  plan.cgtAllowanceRemaining = Math.max(0, plan.cgtAllowanceRemaining - gain);
  plan.runningGain += gain;
  return { taxableNonSavings: 0, realisedGain: gain, lsaUsed: 0 };
}

function buildSteps(plans: Record<PersonId, PersonPlan>, config: StrategyConfig): Step[] {
  const persons: PersonId[] = ["nick", "tracy"];
  const steps: Step[] = [];
  // Preserving the ISA keeps its tax-free shelter for later (after taxable pension); otherwise
  // it comes straight after the allowances that expire this year (pension in the personal
  // allowance, GIA in the CGT exempt amount), but before anything that is taxed.
  const isaPriority = config.preserveIsa ? 60 : 25;

  for (const person of persons) {
    const p = plans[person].p;
    const paTop = p.personalAllowance;
    // Above the taper threshold the personal allowance is withdrawn £1 per £2 (an effective
    // 60% band), so "within the band" draws stop there — once thresholds are indexed the
    // basic-rate top can pass it. Only the last-resort step goes beyond.
    const basicTop = Math.min(p.personalAllowance + p.basicRateBand, p.paTaperThreshold);
    const higherTop = Math.min(p.personalAllowance + p.basicRateBand + p.higherRateBand, p.paTaperThreshold);

    // 1. Pension within personal allowance (0% on the taxable slice).
    if (config.fillPersonalAllowanceFromPension) {
      steps.push({
        person,
        source: "pension",
        priority: 10,
        available: pensionWithinBand(paTop, false),
        effect: pensionEffect,
      });
    }
    // 2. GIA gains within the CGT annual exempt amount (0% CGT).
    steps.push({
      person,
      source: "gia",
      priority: 20,
      available: giaWithinCgtAllowance(),
      effect: giaEffect,
    });
    // 3. Pension up to the basic-rate band (~15% effective).
    steps.push({
      person,
      source: "pension",
      priority: 30,
      available: pensionWithinBand(basicTop, true),
      effect: pensionEffect,
    });
    // 4. GIA at the basic CGT rate.
    steps.push({
      person,
      source: "gia",
      priority: 40,
      available: giaAny(),
      effect: giaEffect,
    });
    // 5. ISA (0% but usually preserved -> late by default).
    steps.push({
      person,
      source: "isa",
      priority: isaPriority,
      available: (_pl, state) => state.balances[person].isa,
      effect: () => ({ taxableNonSavings: 0, realisedGain: 0, lsaUsed: 0 }),
    });
    // 6. Pension up to the higher-rate band.
    steps.push({
      person,
      source: "pension",
      priority: 70,
      available: pensionWithinBand(higherTop, true),
      effect: pensionEffect,
    });
    // 7. Pension beyond (additional rate) — last resort.
    steps.push({
      person,
      source: "pension",
      priority: 90,
      available: (_pl, state) => (plans[person].pensionAccessible ? state.balances[person].pension : 0),
      effect: pensionEffect,
    });
  }
  return steps.sort((a, b) => a.priority - b.priority || a.person.localeCompare(b.person));
}

export interface RaiseContext {
  plans: Record<PersonId, PersonPlan>;
  config: StrategyConfig;
  year: number;
  /** "person:source" pairs the planner must not sell from (fixed by a user override). */
  exclude?: Set<string>;
}

export function makePlan(
  person: PersonId,
  pensionAccessible: boolean,
  preexistingNonSavings: number,
  gainFraction: number,
  p: TaxYearParams,
  /** The year's savings income and dividends so far (a bare number is treated as savings). */
  other: number | { savings: number; dividends: number } = 0,
  /** Gains already realised this tax year (Bed & ISA, earlier sales): they use the CGT
   *  exempt amount first, so "within the allowance" sales only get what is left. */
  gainSoFar = 0,
  /** Lump Sum Allowance still available (defaults to the full allowance). */
  lsaRemaining = LUMP_SUM_ALLOWANCE,
): PersonPlan {
  const { savings, dividends } = typeof other === "number" ? { savings: other, dividends: 0 } : other;
  return {
    person,
    pensionAccessible,
    runningNonSavings: preexistingNonSavings,
    otherIncome: savings + dividends,
    savings,
    dividends,
    runningGain: gainSoFar,
    cgtAllowanceRemaining: Math.max(0, p.cgtAnnualExempt - gainSoFar),
    gainFraction: Math.max(0, Math.min(1, gainFraction)),
    lsaRemaining: Math.max(0, lsaRemaining),
    p,
  };
}

/**
 * Decide how to raise `grossTarget` of cash into the buffer, tax-efficiently.
 * Returns the planned withdrawals (not yet applied to the real state — the engine applies them).
 * The passed `state` is used read-only to size caps; withdrawals are tracked internally so
 * successive steps see reduced balances.
 */
export function raiseCash(
  state: SimState,
  grossTarget: number,
  ctx: RaiseContext,
): Withdrawal[] {
  if (grossTarget <= 0) return [];
  const steps = buildSteps(ctx.plans, ctx.config);
  const withdrawals: Withdrawal[] = [];

  // Working shadow of the balances so caps shrink as we withdraw.
  const shadow: SimState = {
    ...state,
    balances: {
      nick: { ...state.balances.nick },
      tracy: { ...state.balances.tracy },
    },
    gilts: state.gilts,
  };

  let need = grossTarget;
  for (const step of steps) {
    if (need <= 0.005) break;
    if (ctx.exclude?.has(`${step.person}:${step.source}`)) continue;
    const plan = ctx.plans[step.person];
    const avail = step.available(plan, shadow);
    const take = Math.min(need, Math.max(0, avail));
    if (take <= 0.005) continue;

    const eff = step.effect(plan, take);
    shadow.balances[step.person][step.source === "gilt" ? "savings" : step.source] -=
      step.source === "gilt" ? 0 : take;

    withdrawals.push({
      person: step.person,
      source: step.source,
      gross: take,
      taxableNonSavings: eff.taxableNonSavings,
      realisedGain: eff.realisedGain,
      lsaUsed: eff.lsaUsed,
      decisionKey: `${ctx.year}:refill:${step.person}:${step.source}:${step.priority}`,
    });
    need -= take;
  }
  return withdrawals;
}

// --- True per-year optimiser: exact-cost segment greedy ---------------------------------
// Each candidate sale is priced with the same personYearTax the engine uses for the bill, so
// the cost includes savings and dividends stacked on top of pension income, the shrinking
// savings starting-rate band and PSA, the 60% allowance taper, the real £125,140 start of the
// 45% rate, the Lump Sum Allowance running out and the CGT bands. Sales are made in chunks up
// to the next point where a source's marginal rate can change, choosing the cheapest chunk on
// average each time; ties go to the allowances that expire this year (pension, then GIA) before
// the ISA, which keeps its tax-free shelter for later.

const PERSONS: PersonId[] = ["nick", "tracy"];
/** Preference at equal cost: use-it-or-lose-it allowances first, the ISA last. */
const SOURCE_ORDER: SellSource[] = ["pension", "gia", "isa"];
/** The smallest chunk considered, so a missed kink costs at most this much accuracy. */
const MIN_CHUNK = 500;
/** Costs within this of each other (per £) are ties: the tax is rounded to pennies, so equal
 *  rates on different chunk sizes differ by ~1e-5, while real rate steps are ~1% or more. */
const TIE = 1e-4;

/** The plan's year tax with extra taxable income and/or gains. */
function planTax(plan: PersonPlan, extraNonSavings: number, extraGain: number): number {
  return personYearTax(
    {
      nonSavings: plan.runningNonSavings + extraNonSavings,
      savings: plan.savings,
      dividends: plan.dividends,
      gain: plan.runningGain + extraGain,
    },
    plan.p,
  ).total;
}

/** Gross pension amounts (from now) at which the marginal rate can change. */
function pensionKinks(plan: PersonPlan): number[] {
  const { p } = plan;
  const ns = plan.runningNonSavings;
  const other = plan.savings + plan.dividends;
  const points = [
    p.personalAllowance,
    p.personalAllowance + p.savingsStartingRateBand,
    p.personalAllowance + p.basicRateBand - other - BAND_MARGIN, // just inside the PSA cliff
    p.personalAllowance + p.basicRateBand - other,
    p.personalAllowance + p.basicRateBand,
    p.paTaperThreshold - other,
    p.paTaperThreshold + 2 * p.personalAllowance - other,
    p.basicRateBand + p.higherRateBand - other - BAND_MARGIN,
    p.basicRateBand + p.higherRateBand - other,
    p.basicRateBand + p.higherRateBand,
  ];
  const out = points
    .map((x) => x - ns)
    .filter((d) => d > 0.5)
    .map((d) => pensionGrossForTaxable(d, plan.lsaRemaining));
  if (plan.lsaRemaining > 0.5) out.push(4 * plan.lsaRemaining); // where the 25% tax-free part runs out
  return out;
}

/** Gross GIA sales (from now) at which the CGT marginal rate can change. */
function giaKinks(plan: PersonPlan): number[] {
  if (plan.gainFraction <= 0) return [];
  const { p } = plan;
  const exemptLeft = Math.max(0, p.cgtAnnualExempt - plan.runningGain);
  const taxable = personYearTax(
    { nonSavings: plan.runningNonSavings, savings: plan.savings, dividends: plan.dividends, gain: 0 },
    p,
  ).taxableTotal;
  const bandLeft = Math.max(0, p.basicRateBand - taxable);
  return [exemptLeft, exemptLeft + bandLeft].filter((g) => g > 0.5).map((g) => g / plan.gainFraction);
}

/**
 * Raise `grossTarget` while minimising *this tax year's* tax, by exact-cost greedy over
 * pension / GIA / ISA for both people. Aggregated into one withdrawal per (person, source).
 */
export function raiseCashMarginal(
  state: SimState,
  grossTarget: number,
  ctx: RaiseContext,
): Withdrawal[] {
  if (grossTarget <= 0) return [];
  const shadow = {
    nick: { ...state.balances.nick },
    tracy: { ...state.balances.tracy },
  };
  const taken: Record<string, Withdrawal> = {};
  const baseTax: Record<PersonId, number> = {
    nick: planTax(ctx.plans.nick, 0, 0),
    tracy: planTax(ctx.plans.tracy, 0, 0),
  };

  let need = grossTarget;
  const maxIters = Math.ceil(grossTarget / MIN_CHUNK) + 200;
  for (let guard = 0; need > 0.5 && guard < maxIters; guard++) {
    let best: { person: PersonId; source: SellSource; chunk: number; avg: number; order: number } | null = null;
    for (const person of PERSONS) {
      const plan = ctx.plans[person];
      for (const [order, source] of SOURCE_ORDER.entries()) {
        if (ctx.exclude?.has(`${person}:${source}`)) continue;
        if (source === "pension" && !plan.pensionAccessible) continue;
        const avail = Math.min(need, shadow[person][source]);
        if (avail <= 0.5) continue;
        const kinks = source === "pension" ? pensionKinks(plan) : source === "gia" ? giaKinks(plan) : [];
        const next = kinks.length ? Math.min(...kinks) : Infinity;
        for (const chunk of new Set([Math.min(avail, next), Math.min(avail, MIN_CHUNK)])) {
          if (chunk <= 0.5) continue;
          let cost = 0;
          if (source === "pension") {
            cost = planTax(plan, chunk - lsaUsedBy(chunk, plan.lsaRemaining), 0) - baseTax[person];
          } else if (source === "gia") {
            cost = planTax(plan, 0, chunk * plan.gainFraction) - baseTax[person];
          }
          const avg = cost / chunk;
          const better =
            !best ||
            avg < best.avg - TIE ||
            (Math.abs(avg - best.avg) <= TIE &&
              (order < best.order || (order === best.order && chunk > best.chunk)));
          if (better) best = { person, source, chunk, avg, order };
        }
      }
    }
    if (!best) break; // nothing left to sell
    const plan = ctx.plans[best.person];
    const eff =
      best.source === "pension"
        ? pensionEffect(plan, best.chunk)
        : best.source === "gia"
          ? giaEffect(plan, best.chunk)
          : { taxableNonSavings: 0, realisedGain: 0, lsaUsed: 0 };
    shadow[best.person][best.source] -= best.chunk;
    baseTax[best.person] = planTax(plan, 0, 0);
    const key = `${best.person}:${best.source}`;
    const w = (taken[key] ??= {
      person: best.person,
      source: best.source,
      gross: 0,
      taxableNonSavings: 0,
      realisedGain: 0,
      lsaUsed: 0,
      decisionKey: `${ctx.year}:${best.person}:${best.source}`,
    });
    w.gross += best.chunk;
    w.taxableNonSavings += eff.taxableNonSavings;
    w.realisedGain += eff.realisedGain;
    w.lsaUsed += eff.lsaUsed;
    need -= best.chunk;
  }
  return Object.values(taken);
}

/**
 * A fixed withdrawal (e.g. a user override) built against a plan exactly like the planners'
 * own sales — pension taxable via the Lump Sum Allowance, GIA gain via the live gain fraction —
 * and charged to the plan so automatic sales on top of it are priced correctly.
 */
export function planWithdrawal(
  plan: PersonPlan,
  source: SellSource,
  gross: number,
  decisionKey: string,
): Withdrawal {
  const eff =
    source === "pension"
      ? pensionEffect(plan, gross)
      : source === "gia"
        ? giaEffect(plan, gross)
        : { taxableNonSavings: 0, realisedGain: 0, lsaUsed: 0 };
  return { person: plan.person, source, gross, ...eff, decisionKey };
}
