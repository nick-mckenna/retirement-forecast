import type { PersonId, StrategyConfig, TaxYearParams } from "../model/types";
import type { SimState } from "../engine/state";
import {
  LUMP_SUM_ALLOWANCE,
  lsaUsedBy,
  marginalTaxableShare,
  pensionGrossForTaxable,
} from "../tax/pensionDraw";

export type Source = "pension" | "gia" | "gilt" | "isa";
/** Sources the marginal optimiser can draw from (gilts are the buffer, not a raise source). */
type SellSource = "isa" | "pension" | "gia";

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

function pensionWithinBand(bandTop: number, netOfOtherIncome: boolean) {
  return (plan: PersonPlan, state: SimState) => {
    if (!plan.pensionAccessible) return 0;
    const pot = state.balances[plan.person].pension;
    if (pot <= 0) return 0;
    // Keep the taxable part within the band top (75% of the gross while the Lump Sum Allowance
    // lasts, all of it after). Above the personal allowance the year's savings and dividends
    // stack on top, so they use up band room too.
    const top = netOfOtherIncome ? bandTop - plan.otherIncome : bandTop;
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
  return { taxableNonSavings: 0, realisedGain: gain, lsaUsed: 0 };
}

function buildSteps(plans: Record<PersonId, PersonPlan>, config: StrategyConfig): Step[] {
  const persons: PersonId[] = ["nick", "tracy"];
  const steps: Step[] = [];
  const isaPriority = config.preserveIsa ? 60 : 15;

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
}

export function makePlan(
  person: PersonId,
  pensionAccessible: boolean,
  preexistingNonSavings: number,
  gainFraction: number,
  p: TaxYearParams,
  otherIncome = 0,
  /** Gains already realised this tax year (Bed & ISA, earlier sales): they use the CGT
   *  exempt amount first, so "within the allowance" sales only get what is left. */
  gainSoFar = 0,
  /** Lump Sum Allowance still available (defaults to the full allowance). */
  lsaRemaining = LUMP_SUM_ALLOWANCE,
): PersonPlan {
  return {
    person,
    pensionAccessible,
    runningNonSavings: preexistingNonSavings,
    otherIncome,
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

// --- True per-year optimiser: marginal-cost greedy -------------------------------------
// Repeatedly take a small increment of cash from whichever (person, source) has the lowest
// actual marginal tax cost at the current state, recomputing after each increment. Because
// the per-year tax cost is convex in each source, marginal-cost greedy reaches the tax
// minimum for raising the required cash this tax year.

function marginalIncomeRate(runningNonSavings: number, p: TaxYearParams): number {
  // Personal allowance left at this income (withdrawn £1 per £2 above the taper threshold);
  // bands are measured on taxable income, so the 45% rate starts at £125,140 *taxable*.
  const pa = Math.max(0, p.personalAllowance - Math.max(0, (runningNonSavings - p.paTaperThreshold) / 2));
  if (runningNonSavings < pa) return 0;
  const taxable = runningNonSavings - pa;
  let rate: number;
  if (taxable < p.basicRateBand) rate = p.basicRate;
  else if (taxable < p.basicRateBand + p.higherRateBand) rate = p.higherRate;
  else rate = p.additionalRate;
  // In the taper zone each extra £1 also removes 50p of allowance, taxed at the same rate.
  const taperEnd = p.paTaperThreshold + 2 * p.personalAllowance;
  if (runningNonSavings >= p.paTaperThreshold && runningNonSavings < taperEnd) rate *= 1.5;
  return rate;
}

/** Marginal tax on the next £1 of *gross* raised from a source, at the plan's current state. */
function marginalCost(source: Source, plan: PersonPlan): number {
  if (source === "isa" || source === "gilt") return 0;
  // Savings and dividends sit on top of pension income, so the next £1 of pension is priced at
  // the top of the stack (it pushes £1 of them up the bands).
  if (source === "pension") {
    return marginalTaxableShare(plan.lsaRemaining) * marginalIncomeRate(plan.runningNonSavings + plan.otherIncome, plan.p);
  }
  // GIA: only the gain fraction is taxable, and only above the CGT annual exempt amount.
  if (plan.cgtAllowanceRemaining > 0.5) return 0;
  const cgtRate =
    plan.runningNonSavings < plan.p.personalAllowance + plan.p.basicRateBand
      ? plan.p.cgtBasicRate
      : plan.p.cgtHigherRate;
  return plan.gainFraction * cgtRate;
}

function applyMarginal(source: Source, plan: PersonPlan, take: number) {
  if (source === "pension") return pensionEffect(plan, take);
  if (source === "gia") return giaEffect(plan, take);
  return { taxableNonSavings: 0, realisedGain: 0, lsaUsed: 0 };
}

/**
 * Raise `grossTarget` while minimising *this tax year's* tax, by marginal-cost greedy over
 * pension / GIA / ISA for both people. Aggregated into one withdrawal per (person, source).
 */
export function raiseCashMarginal(
  state: SimState,
  grossTarget: number,
  ctx: RaiseContext,
): Withdrawal[] {
  if (grossTarget <= 0) return [];
  const persons: PersonId[] = ["nick", "tracy"];
  const sources: SellSource[] = ["isa", "pension", "gia"];
  const shadow = {
    nick: { ...state.balances.nick },
    tracy: { ...state.balances.tracy },
  };
  const taken: Record<string, Withdrawal> = {};

  // The increment scales with the target (for speed) but in whole £500 steps, so it only
  // changes when T crosses a step boundary: the year-end refill solves a fixed point in T,
  // which a continuously T-dependent increment would make jumpy.
  const step = Math.max(500, Math.ceil(grossTarget / 600 / 500) * 500);
  let need = grossTarget;
  let guard = 0;
  const maxIters = Math.ceil(grossTarget / step) + 100;

  while (need > 0.5 && guard++ < maxIters) {
    let best: { person: PersonId; source: SellSource; cost: number; avail: number } | null = null;
    for (const person of persons) {
      const plan = ctx.plans[person];
      for (const source of sources) {
        if (source === "pension" && !plan.pensionAccessible) continue;
        const avail = shadow[person][source];
        if (avail <= 0.5) continue;
        const cost = marginalCost(source, plan);
        if (!best || cost < best.cost) best = { person, source, cost, avail };
      }
    }
    if (!best) break; // nothing left to sell
    const take = Math.min(step, need, best.avail);
    const plan = ctx.plans[best.person];
    const eff = applyMarginal(best.source, plan, take);
    shadow[best.person][best.source] -= take;
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
    w.gross += take;
    w.taxableNonSavings += eff.taxableNonSavings;
    w.realisedGain += eff.realisedGain;
    w.lsaUsed += eff.lsaUsed;
    need -= take;
  }
  return Object.values(taken);
}
