import type { PersonId, Scenario } from "../model/types";
import { annualToMonthly } from "../model/rates";
import { resolveIncome, targetForYear } from "../model/incomeTargets";
import {
  statePensionForYear,
  statePensionGrowth,
  statePensionInPeriod,
  statePensionRate,
  statePensionStartDate,
} from "../tax/statePension";
import { lsaUsedBy, pensionGrossForTaxable, pensionTaxable } from "../tax/pensionDraw";
import { coupleYearTax, personYearTax } from "../tax/personTax";
import { resolveTaxParams } from "../tax/taxParams";
import { ageAtTaxYearStart, ageOn, addMonths, modelStartDate, parseDate, toIso } from "../tax/taxYear";
import { bufferTarget, currentBuffer } from "../strategy/buffer";
import {
  makePlan,
  planWithdrawal,
  raiseCash,
  raiseCashMarginal,
  type SellSource,
  type Withdrawal,
} from "../strategy/drawdown";
import { planGiltPurchases, type RealGiltMarket } from "../strategy/giltLadder";
import {
  EMPLOYER_PENSION_ROW_LABEL,
  emptyPersonColumns,
  INCOME_ROW_LABELS,
  type LedgerRow,
  type PersonColumns,
} from "./ledger";
import {
  giaGainFraction,
  giltValue,
  initState,
  isRealGilt,
  redemptionOf,
  sellGia,
  sellGilts,
  type GiltHolding,
  type GiltSalePrice,
  type SimState,
} from "./state";
import {
  MONEY_PURCHASE_ANNUAL_ALLOWANCE,
  PENSION_ANNUAL_ALLOWANCE,
  PREMIUM_BOND_LIMIT,
} from "../tax/allowanceLimits";
import type { GiltInstrument, GiltTerms, SimContext } from "../gilts/types";
import { buildPricing } from "../gilts/pricing";
import { accruedPer100, addDays, couponPer100, couponsBetween, fundsYear, remainingCoupons } from "../gilts/schedule";

const PERSONS: PersonId[] = ["nick", "tracy"];


export interface PersonTax {
  incomeTax: number;
  cgt: number;
  /** The full liability for the year (income tax + CGT) — what "total tax" sums. */
  total: number;
  /** Tax already deducted at source this year (PAYE on the final employment income). */
  paidAtSource: number;
  /** total − paidAtSource: what is settled from cash at year end (negative = a refund). */
  due: number;
  taxableNonSavings: number;
  savingsIncome: number;
  dividends: number;
  realisedGain: number;
}

/** Everything sold/disposed of in a tax year, for the disposals view. */
export interface YearDisposals {
  /** Gross drawn from each pot to raise cash (refill + lifetime top-up). */
  sales: Record<PersonId, { pension: number; gia: number; isa: number }>;
  /** GIA moved into the ISA via Bed & ISA (a CGT disposal). */
  isaFill: Record<PersonId, number>;
  /** Gilts redeemed at par during the year (CGT-exempt). */
  giltMaturities: Record<PersonId, number>;
  /** Gilts sold early because cash ran out before the year-end refill (the cash raised: par for
   *  the engine's own gilts, the market price for real ones). */
  giltSales: Record<PersonId, number>;
  /** Total capital gain realised on GIA disposals (sales + Bed & ISA). */
  realisedGain: Record<PersonId, number>;
}

export interface YearSummary {
  taxYearStart: number;
  nickAge: number;
  tracyAge: number;
  incomeTarget: number;
  bufferTargetValue: number;
  bufferEnd: number;
  netWorthEnd: number;
  tax: Record<PersonId, PersonTax>;
  withdrawals: Withdrawal[];
  giltPurchasesValue: number;
  disposals: YearDisposals;
  /** Income tax still to come on the pensions left at year end, if drawn evenly over ten
   *  years on top of the State Pension (after any Lump Sum Allowance left). Display only. */
  deferredPensionTax: number;
  /** netWorthEnd less deferredPensionTax. */
  netWorthAfterPensionTax: number;
}

function newDisposals(): YearDisposals {
  return {
    sales: { nick: { pension: 0, gia: 0, isa: 0 }, tracy: { pension: 0, gia: 0, isa: 0 } },
    isaFill: { nick: 0, tracy: 0 },
    giltMaturities: { nick: 0, tracy: 0 },
    giltSales: { nick: 0, tracy: 0 },
    realisedGain: { nick: 0, tracy: 0 },
  };
}

export interface GiltRecord {
  holder: PersonId;
  name: string;
  nominal: number;
  couponRate: number;
  purchaseDateIso: string;
  maturityDateIso: string;
  /** True for gilts already held at the model start (not bought by the ladder). */
  initial: boolean;
  /** Real gilts only: ISIN. */
  isin?: string;
  /** Real gilts bought by the ladder: clean price paid per £100, the cash it cost, its gross
   *  redemption yield and its yield after tax at the holder's marginal rate (`taxRate`). */
  cleanPrice?: number;
  cost?: number;
  grossYield?: number;
  netYield?: number;
  taxRate?: number;
}

export interface SimResult {
  rows: LedgerRow[];
  years: YearSummary[];
  warnings: string[];
  gilts: GiltRecord[];
}

/** The engine's own gilts mature at the start of their tax year (6 April). */
function maturityIso(maturityYear: number): string {
  return `${maturityYear}-04-06`;
}

function termsOf(g: GiltHolding): GiltTerms {
  return { couponRate: g.couponRate, redemptionDate: redemptionOf(g) };
}

function shortDateIso(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

interface Accum {
  /** Taxable non-savings income from sales/earnings (pension drawdown, final salary). */
  taxableNonSavings: Record<PersonId, number>;
  /** State Pension actually credited this year (only the modelled months). */
  statePension: Record<PersonId, number>;
  savingsIncome: Record<PersonId, number>;
  dividends: Record<PersonId, number>;
  realisedGain: Record<PersonId, number>;
  /** Tax deducted at source (PAYE on the final salary). */
  paidAtSource: Record<PersonId, number>;
}

function newAccum(): Accum {
  return {
    taxableNonSavings: { nick: 0, tracy: 0 },
    statePension: { nick: 0, tracy: 0 },
    savingsIncome: { nick: 0, tracy: 0 },
    dividends: { nick: 0, tracy: 0 },
    realisedGain: { nick: 0, tracy: 0 },
    paidAtSource: { nick: 0, tracy: 0 },
  };
}

type Deltas = Partial<Record<PersonId, Partial<PersonColumns>>>;
const addDelta = (d: Deltas, id: PersonId, col: keyof PersonColumns, v: number): void => {
  if (v === 0) return;
  const row = (d[id] ??= {});
  row[col] = (row[col] ?? 0) + v;
};

/**
 * Run the whole plan. `ctx` carries what isn't part of the persisted scenario: real gilts
 * handed over from the pre-retirement module (`openingGilts`) and the gilt market that prices
 * them. Without it — or with no real gilts — every gilt is the engine's own par gilt.
 */
export function simulate(scenario: Scenario, ctx: SimContext = {}): SimResult {
  const state = initState(scenario, ctx.openingGilts ?? []);
  const rows: LedgerRow[] = [];
  const years: YearSummary[] = [];
  const warnings: string[] = [];
  const gilts: GiltRecord[] = state.gilts.map((g) => ({
    holder: g.holder,
    name: g.name,
    nominal: g.nominal,
    couponRate: g.couponRate,
    purchaseDateIso: scenario.startDate,
    maturityDateIso: redemptionOf(g),
    initial: true,
    ...(isRealGilt(g) ? { isin: g.isin } : {}),
  }));
  const pricing = buildPricing(ctx.giltMarket ?? null, scenario.rates.giltYieldShift ?? 0);
  // What the ladder buys: real gilts when asked for and prices are known; otherwise (or for a
  // rung no real gilt redeems in time for) fictional ones.
  const buyRealGilts = (scenario.strategy.giltUniverse ?? "real") === "real" && pricing.hasMarket;
  const buyable = new Map<number, GiltInstrument[]>();
  if (buyRealGilts) {
    for (const inst of ctx.giltMarket!.instruments) {
      if (inst.indexLinked || inst.rump || !pricing.knows(inst.isin)) continue;
      const list = buyable.get(fundsYear(inst.redemptionDate)) ?? [];
      list.push(inst);
      buyable.set(fundsYear(inst.redemptionDate), list);
    }
    for (const list of buyable.values()) list.sort((a, b) => a.redemptionDate.localeCompare(b.redemptionDate) || a.isin.localeCompare(b.isin));
  } else if ((scenario.strategy.giltUniverse ?? "real") === "real" && "giltMarket" in ctx) {
    warnings.push(
      "No DMO gilt prices yet, so the gilt ladder buys fictional par gilts at the scenario's gilt coupon — " +
        "refresh the gilt market to buy real gilts.",
    );
  }
  /** A holding's market value at the end of `iso`: a real gilt at the sale price plus accrued
   *  interest, the engine's own gilts at par. */
  const holdingValue = (g: GiltHolding, iso: string): number =>
    isRealGilt(g) ? (g.nominal * pricing.dirty(g.isin, termsOf(g), iso, "sell")) / 100 : g.nominal;
  const giltsValueOf = (id: PersonId, iso: string): number => {
    let v = 0;
    for (const g of state.gilts) if (g.holder === id) v += holdingValue(g, iso);
    return v;
  };
  /** What a real gilt sells for on `iso`, per £100 (dirty), and the accrued interest in it. */
  const salePrice = (iso: string): GiltSalePrice => (g) => {
    const terms = termsOf(g);
    const accrued = accruedPer100(terms, iso);
    return { dirty: pricing.clean(g.isin ?? "", terms, iso, "sell") + accrued, accrued };
  };

  const mInv = annualToMonthly(scenario.rates.investmentGrowth);
  const mSav = annualToMonthly(scenario.rates.savingsInterest);
  const mPB = annualToMonthly(scenario.rates.premiumBondRate);
  const startDate = parseDate(scenario.startDate);
  // The model runs from the day after the starting balances; the income start year is the
  // tax year that day falls in (resolveIncome derives it), so a mid-year start gives a part
  // first year rather than skipped or double-counted months.
  const modelStart = modelStartDate(scenario.startDate);
  const income = resolveIncome(scenario);
  const modelStartYear = income.startYear;
  const spGrowth = statePensionGrowth(scenario.rates);
  // The income the buffer must fund each year: the target less both State Pensions.
  const needMemo = new Map<number, number>();
  const netNeed = (year: number): number => {
    let v = needMemo.get(year);
    if (v == null) {
      v = Math.max(
        0,
        targetForYear(income, year) -
          statePensionForYear(scenario.people.nick, year, modelStartYear, spGrowth) -
          statePensionForYear(scenario.people.tracy, year, modelStartYear, spGrowth),
      );
      needMemo.set(year, v);
    }
    return v;
  };
  const spStart: Record<PersonId, Date> = {
    nick: statePensionStartDate(scenario.people.nick),
    tracy: statePensionStartDate(scenario.people.tracy),
  };
  if (scenario.income.startYear !== income.startYear) {
    warnings.push(
      `The income start year (${scenario.income.startYear}) didn't match the start date — modelling from ` +
        `${income.startYear}/${String(income.startYear + 1).slice(2)}, the tax year after ${scenario.startDate}.`,
    );
  }
  // User overrides: fixed year-end refill sales, "year:person:source".
  const fixedSales: { year: number; person: PersonId; source: SellSource; amount: number; key: string }[] = [];
  for (const o of scenario.overrides) {
    const m = /^(\d{4}):(nick|tracy):(pension|gia|isa)$/.exec(o.key);
    if (!m || !Number.isFinite(o.amount) || o.amount < 0) {
      warnings.push(`Override "${o.key}" isn't a valid "year:person:source" sale amount and is ignored.`);
      continue;
    }
    const year = Number(m[1]);
    if (year < income.startYear || year >= income.startYear + income.years) {
      warnings.push(`Override "${o.key}" is for a year outside the forecast and is ignored.`);
      continue;
    }
    fixedSales.push({ year, person: m[2] as PersonId, source: m[3] as SellSource, amount: o.amount, key: o.key });
  }
  const clampWarned = new Set<string>();
  const purchases = (scenario.purchases ?? []).map((pp) => ({ ...pp, at: parseDate(pp.date).getTime() }));
  const handledPurchases = new Set<string>();
  /** Income the monthly draw could not pay, per tax year (with the first month it happened). */
  const shortfalls = new Map<number, { amount: number; firstMonthIso: string }>();

  // The gilts column is booked at market value: before each balance row, any difference between
  // what the deltas have booked and the gilts' value then (price movement, accrued interest) is
  // booked as a revaluation, so every balance row still reconciles. The engine's own gilts are
  // valued at par, so they never revalue.
  const booked: Record<PersonId, number> = { nick: 0, tracy: 0 };
  let bookedInit = false;
  const balanceRow = (label: string, dateIso: string, valueIso: string = dateIso): void => {
    const value = { nick: giltsValueOf("nick", valueIso), tracy: giltsValueOf("tracy", valueIso) };
    if (bookedInit) {
      const reval: Deltas = {};
      for (const id of PERSONS) {
        const diff = value[id] - booked[id];
        if (Math.abs(diff) > 0.005) reval[id] = { giltsTotal: diff };
      }
      if (Object.keys(reval).length) txRow("Gilt revaluation", dateIso, reval);
    }
    for (const id of PERSONS) booked[id] = value[id];
    bookedInit = true;
    const nick = snapshot("nick", value.nick);
    const tracy = snapshot("tracy", value.tracy);
    const savingsAndGilts =
      nick.savings + tracy.savings + nick.giltsTotal + tracy.giltsTotal;
    const netWorth =
      nick.isa + nick.pension + nick.gia + nick.savings + nick.giltsTotal +
      tracy.isa + tracy.pension + tracy.gia + tracy.savings + tracy.giltsTotal;
    rows.push({ type: "BALANCE", label, dateIso, nick, tracy, savingsAndGilts, netWorth });
  };
  const snapshot = (id: PersonId, giltsTotal: number): PersonColumns => {
    const b = state.balances[id];
    return {
      income: 0,
      isa: b.isa,
      pension: b.pension,
      gia: b.gia,
      savings: b.savings + b.premiumBonds, // Premium Bonds are cash-like: shown with cash
      giltsTotal,
      tax: 0,
    };
  };
  const txRow = (
    label: string,
    dateIso: string,
    deltas: Partial<Record<PersonId, Partial<PersonColumns>>>,
    decisionKey?: string,
  ): void => {
    const nick = { ...emptyPersonColumns(), ...deltas.nick };
    const tracy = { ...emptyPersonColumns(), ...deltas.tracy };
    booked.nick += nick.giltsTotal;
    booked.tracy += tracy.giltsTotal;
    rows.push({
      type: "TRANSACTION",
      label,
      dateIso,
      nick,
      tracy,
      savingsAndGilts: 0,
      netWorth: 0,
      decisionKey,
    });
  };

  // --- Starting position ---
  balanceRow("Starting Balances", toIso(startDate));

  // --- One-off final employment income ---
  // Received in a modelled month, it is earnings of that tax year: the gross (net + PAYE)
  // counts towards the year's income — so pension drawn that year is taxed on top of it —
  // and the PAYE already deducted is credited against the year's bill. Received before the
  // model starts, its tax is outside the plan and only the net cash arrives.
  const fi = scenario.finalIncome;
  const fiAt = parseDate(fi.date).getTime();
  const fiRow = (): Deltas => ({
    nick: { income: fi.perPerson.nick.net, savings: fi.perPerson.nick.net, tax: fi.perPerson.nick.tax },
    tracy: { income: fi.perPerson.tracy.net, savings: fi.perPerson.tracy.net, tax: fi.perPerson.tracy.tax },
  });
  // The employer (e.g. director's) pension contribution paid with it goes straight into the
  // pension: not taxable income, not cash. `drawnBefore` says whether the person's pension has
  // already been drawn in the model, which caps contributions at the money purchase allowance.
  const payEmployerPension = (drawnBefore: (id: PersonId) => boolean): void => {
    const deltas: Deltas = {};
    for (const id of PERSONS) {
      const amount = fi.perPerson[id].employerPension;
      if (!(amount > 0)) continue;
      state.balances[id].pension += amount;
      deltas[id] = { pension: amount };
      const name = scenario.people[id].name;
      if (drawnBefore(id) && amount > MONEY_PURCHASE_ANNUAL_ALLOWANCE) {
        warnings.push(
          `${name}'s employer pension contribution of ${gbp(amount)} on ${fi.date} comes after their pension ` +
            `has been drawn, so the ${gbp(MONEY_PURCHASE_ANNUAL_ALLOWANCE)} money purchase annual allowance ` +
            `applies: the excess would be taxed (not modelled).`,
        );
      } else if (amount > PENSION_ANNUAL_ALLOWANCE + 0.005) {
        warnings.push(
          `${name}'s employer pension contribution of ${gbp(amount)} on ${fi.date} exceeds the ` +
            `${gbp(PENSION_ANNUAL_ALLOWANCE)} annual allowance: the excess would be taxed unless unused ` +
            `allowance is carried forward (not modelled).`,
        );
      }
    }
    if (Object.keys(deltas).length) txRow(EMPLOYER_PENSION_ROW_LABEL, fi.date, deltas);
  };
  const hasNetOrTax = PERSONS.some((id) => fi.perPerson[id].net !== 0 || fi.perPerson[id].tax !== 0);
  let finalIncomeHandled = !hasNetOrTax && PERSONS.every((id) => !(fi.perPerson[id].employerPension > 0));
  if (!finalIncomeHandled && fiAt < modelStart.getTime()) {
    for (const id of PERSONS) state.balances[id].savings += fi.perPerson[id].net;
    if (hasNetOrTax) txRow(INCOME_ROW_LABELS.finalIncome, fi.date, fiRow());
    payEmployerPension(() => false);
    balanceRow("After Final Income", fi.date, scenario.startDate);
    finalIncomeHandled = true;
  }

  // --- Annual loop over tax years ---
  for (let i = 0; i < income.years; i++) {
    const y = income.startYear + i;
    const p = resolveTaxParams(scenario.taxParams, y, scenario.taxPolicy, scenario.rates.inflation);
    const yearStart = new Date(Date.UTC(y, 3, 6)); // 6 April y
    const yearEnd = new Date(Date.UTC(y + 1, 3, 5)); // 5 April y+1
    const accum = newAccum();
    /** One-off earnings this year (the final salary): left out when judging the tax rate future
     *  gilt coupons will pay, since they won't recur. */
    const oneOffIncome: Record<PersonId, number> = { nick: 0, tracy: 0 };
    const withdrawals: Withdrawal[] = [];
    const disposals = newDisposals();

    // A part first year (the model starts after 6 April): months before the start are
    // already behind the starting balances. The year-start events happen on the first day.
    let firstMonth = 0;
    while (firstMonth < 12 && addMonths(yearStart, firstMonth).getTime() < modelStart.getTime()) firstMonth++;
    const yearFraction = (12 - firstMonth) / 12;
    const openIso = toIso(firstMonth === 0 ? yearStart : modelStart);

    // State pension: this year's full annual rate (uprated by the triple-lock floor unless the
    // scenario sets a growth rate), paid monthly from each person's State Pension start date.
    const spRate: Record<PersonId, number> = {
      nick: statePensionRate(scenario.people.nick, y, modelStartYear, spGrowth),
      tracy: statePensionRate(scenario.people.tracy, y, modelStartYear, spGrowth),
    };

    const mode = scenario.strategy.taxMode ?? "heuristic";

    // Apply a set of planned withdrawals to the state (balances, tax accumulators, disposals)
    // and emit a ledger row. Shared by the year-end refill and one-off purchase funding.
    const applyPlanned = (planned: Withdrawal[], label: string, dateIso: string) => {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const w of planned) {
        // The gain actually realised comes from the tracked cost basis (proportional method).
        w.realisedGain = applyWithdrawal(state, w);
        accum.taxableNonSavings[w.person] += w.taxableNonSavings;
        accum.realisedGain[w.person] += w.realisedGain;
        if (w.source === "gilt") disposals.giltSales[w.person] += w.gross;
        else disposals.sales[w.person][w.source] += w.gross;
        withdrawals.push(w);
        const d = (deltas[w.person] ??= {});
        d.savings = (d.savings ?? 0) + w.gross;
        const col: keyof PersonColumns = w.source === "gilt" ? "giltsTotal" : w.source;
        d[col] = (d[col] ?? 0) - w.gross;
      }
      if (planned.length) txRow(label, dateIso, deltas);
    };

    /** Fresh per-person sale plans for a sale on `onDate`, from the year's income so far. */
    const buildPlans = (onDate: Date) => {
      const plan = (id: PersonId) =>
        mkPlan(id, scenario, state, onDate, p, {
          nonSavings: accum.statePension[id] + accum.taxableNonSavings[id],
          other: { savings: accum.savingsIncome[id], dividends: accum.dividends[id] },
          gainSoFar: accum.realisedGain[id],
        });
      return { nick: plan("nick"), tracy: plan("tracy") };
    };

    // This year's income tax + CGT per person from the accumulators so far, plus any `extra`
    // withdrawals not yet applied. Pure, so the year end can provision cash for the bill
    // (including the tax its own sales create) before paying it with the same calculation.
    // The couple is taxed together only through the marriage allowance (coupleYearTax).
    const assessTax = (extra: Withdrawal[] = []): Record<PersonId, PersonTax> => {
      const out: Record<PersonId, PersonTax> = { nick: blankTax(), tracy: blankTax() };
      const income = (id: PersonId) => {
        let extraNonSavings = 0;
        let extraGain = 0;
        for (const w of extra) {
          if (w.person !== id) continue;
          extraNonSavings += w.taxableNonSavings;
          extraGain += w.realisedGain;
        }
        return {
          nonSavings: accum.taxableNonSavings[id] + extraNonSavings + accum.statePension[id],
          savings: accum.savingsIncome[id],
          dividends: accum.dividends[id],
          gain: accum.realisedGain[id] + extraGain,
        };
      };
      const inc = { nick: income("nick"), tracy: income("tracy") };
      const both = coupleYearTax(inc.nick, inc.tracy, p, scenario.married);
      const taxes = { nick: both.a, tracy: both.b };
      for (const id of PERSONS) {
        const parts = inc[id];
        const gain = parts.gain;
        const t = taxes[id];
        out[id] = {
          incomeTax: t.incomeTax,
          cgt: t.cgt,
          total: t.total,
          paidAtSource: round2(accum.paidAtSource[id]),
          due: round2(t.total - accum.paidAtSource[id]),
          taxableNonSavings: round2(parts.nonSavings),
          savingsIncome: round2(parts.savings),
          dividends: round2(parts.dividends),
          realisedGain: round2(gain),
        };
      }
      return out;
    };
    /** A person's marginal income-tax rate on savings income — what the next £1,000 of coupons
     *  would cost them — in this year's position less its one-off earnings (the coupons fall in
     *  later years), for ranking gilts by their yield after tax. */
    const marginalSavingsRate = (id: PersonId): number => {
      const base = {
        nonSavings: Math.max(0, accum.taxableNonSavings[id] - oneOffIncome[id]) + accum.statePension[id],
        savings: accum.savingsIncome[id],
        dividends: accum.dividends[id],
        gain: 0,
      };
      const step = 1000;
      return (personYearTax({ ...base, savings: base.savings + step }, p).total - personYearTax(base, p).total) / step;
    };

    /** Cash the year's tax still takes at year end (after PAYE already paid at source). */
    const taxDue = (extra?: Withdrawal[]): number => {
      const t = assessTax(extra);
      return t.nick.due + t.tracy.due;
    };

    /**
     * How much to sell at year end so the cash + gilts buffer still reaches `target` once this
     * year's tax has been paid out of it. The sale creates tax of its own (pension income, GIA
     * gains), so solve T = target − buffer + tax(after selling T) by fixed-point iteration; it
     * converges fast because each extra £1 raised costs well under £1 in tax.
     */
    /**
     * This year's refill sales for a cash target: the user's fixed sales (clamped to what each
     * pot holds, and charged to the plans so the rest is priced on top of them), then the
     * automatic plan for the remainder from the pots that aren't fixed.
     */
    const refillSales = (target: number, plans: ReturnType<typeof buildPlans>): Withdrawal[] => {
      const exclude = new Set<string>();
      const fixed: Withdrawal[] = [];
      for (const o of fixedSales) {
        if (o.year !== y) continue;
        exclude.add(`${o.person}:${o.source}`);
        const acc = state.balances[o.person];
        const plan = plans[o.person];
        const cap = o.source === "pension" ? (plan.pensionAccessible ? acc.pension : 0) : acc[o.source];
        let amount = o.amount;
        if (amount > cap + 0.5) {
          if (!clampWarned.has(o.key)) {
            clampWarned.add(o.key);
            warnings.push(
              `Override "${o.key}" asks for ${gbp(o.amount)} but only ${gbp(cap)} can be sold from that pot — selling ${gbp(cap)}.`,
            );
          }
          amount = cap;
        }
        if (amount > 0.5) fixed.push(planWithdrawal(plan, o.source, amount, o.key));
      }
      const rest = target - fixed.reduce((t, w) => t + w.gross, 0);
      if (rest <= 1) return fixed;
      const ctx = { plans, config: scenario.strategy, year: y, exclude };
      const auto = mode === "heuristic" ? raiseCash(state, rest, ctx) : raiseCashMarginal(state, rest, ctx);
      return [...fixed, ...auto];
    };

    const refillAmount = (target: number): number => {
      const sell = (t: number): Withdrawal[] => refillSales(t, buildPlans(yearEnd));
      const gapBeforeSale = target - currentBuffer(state, bufferValue);
      let t = gapBeforeSale + taxDue();
      for (let k = 0; k < 50; k++) {
        const next = gapBeforeSale + taxDue(sell(t));
        if (Math.abs(next - t) < 0.5) return next;
        t = next;
      }
      return t;
    };

    /** Raise `target` cash by selling investments tax-efficiently; returns the gross raised. */
    const fundCash = (target: number, label: string, dateIso: string): number => {
      if (target <= 1) return 0;
      const ctx = { plans: buildPlans(parseDate(dateIso)), config: scenario.strategy, year: y };
      const planned =
        mode === "heuristic"
          ? raiseCash(state, target, ctx)
          : raiseCashMarginal(state, target, ctx);
      applyPlanned(planned, label, dateIso);
      return planned.reduce((s, w) => s + w.gross, 0);
    };

    // Coupons and redemptions of real gilts dated in [fromIso, toIsoExcl): cash in; coupons are
    // taxable savings income beyond any accrued-income credit; a redemption repays the nominal
    // (CGT-exempt). Booked on their actual dates.
    const realGiltEvents = (fromIso: string, toIsoExcl: string): void => {
      if (fromIso >= toIsoExcl) return;
      const fromExcl = addDays(fromIso, -1);
      const toIncl = addDays(toIsoExcl, -1);
      const byDate = new Map<string, { coupons: Deltas; redemptions: Deltas }>();
      const at = (iso: string) => {
        let e = byDate.get(iso);
        if (!e) byDate.set(iso, (e = { coupons: {}, redemptions: {} }));
        return e;
      };
      const redeemed = new Set<GiltHolding>();
      for (const g of state.gilts) {
        if (!isRealGilt(g)) continue;
        const terms = termsOf(g);
        for (const c of couponsBetween(terms, fromExcl, toIncl)) {
          const amount = (g.nominal * couponPer100(terms)) / 100;
          const relief = Math.min(g.aisCredit ?? 0, amount);
          if (relief > 0) g.aisCredit = (g.aisCredit ?? 0) - relief;
          state.balances[g.holder].savings += amount;
          accum.savingsIncome[g.holder] += amount - relief;
          addDelta(at(c).coupons, g.holder, "savings", amount);
        }
        if (g.redemptionIso > fromExcl && g.redemptionIso <= toIncl) {
          state.balances[g.holder].savings += g.nominal;
          disposals.giltMaturities[g.holder] += g.nominal;
          addDelta(at(g.redemptionIso).redemptions, g.holder, "savings", g.nominal);
          addDelta(at(g.redemptionIso).redemptions, g.holder, "giltsTotal", -g.nominal);
          redeemed.add(g);
        }
      }
      if (redeemed.size > 0) state.gilts = state.gilts.filter((g) => !redeemed.has(g));
      for (const date of [...byDate.keys()].sort()) {
        const e = byDate.get(date)!;
        if (Object.keys(e.coupons).length) txRow("Gilt Coupon", date, e.coupons);
        if (Object.keys(e.redemptions).length) txRow("Gilt Maturity", date, e.redemptions);
      }
    };

    // The engine's own gilt maturities (redeem at par -> cash; capital gain CGT-exempt).
    const matured = state.gilts.filter((g) => !isRealGilt(g) && g.maturityYear <= y);
    if (matured.length > 0) {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const g of matured) {
        state.balances[g.holder].savings += g.nominal;
        disposals.giltMaturities[g.holder] += g.nominal;
        deltas[g.holder] = {
          savings: (deltas[g.holder]?.savings ?? 0) + g.nominal,
          giltsTotal: (deltas[g.holder]?.giltsTotal ?? 0) - g.nominal,
        };
      }
      state.gilts = state.gilts.filter((g) => isRealGilt(g) || g.maturityYear > y);
      txRow("Gilt Maturity", openIso, deltas);
    }

    // The engine's own gilt coupons (taxable savings income; paid into cash) — for the modelled
    // part of the year.
    if (state.gilts.length > 0 && yearFraction > 0) {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const g of state.gilts) {
        if (isRealGilt(g)) continue;
        const coupon = g.nominal * g.couponRate * yearFraction;
        state.balances[g.holder].savings += coupon;
        accum.savingsIncome[g.holder] += coupon;
        deltas[g.holder] = { savings: (deltas[g.holder]?.savings ?? 0) + coupon };
      }
      if (Object.keys(deltas).length) txRow("Gilt Coupon", openIso, deltas);
    }

    // Remaining ISA subscription allowance per person this tax year (consumed by Bed & ISA
    // and by any lifetime-mode pension-to-ISA top-up).
    const isaRoom: Record<PersonId, number> = { nick: p.isaAllowance, tracy: p.isaAllowance };

    // ISA fill: Bed & ISA from GIA (realises gain -> CGT; moves into tax-free wrapper).
    {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      let any = false;
      for (const id of PERSONS) {
        const acc = state.balances[id];
        const fill = Math.min(isaRoom[id], acc.gia);
        if (fill > 1) {
          const { gain } = sellGia(acc, fill);
          acc.isa += fill;
          accum.realisedGain[id] += gain;
          disposals.isaFill[id] += fill;
          isaRoom[id] -= fill;
          deltas[id] = { isa: fill, gia: -fill };
          any = true;
        }
      }
      if (any) txRow("ISA Fill (Bed & ISA)", openIso, deltas);
    }

    // Real gilts' coupons and redemptions between the model start and the first modelled month.
    realGiltEvents(openIso, toIso(addMonths(yearStart, firstMonth)));

    // --- Monthly steps (all 12, or those after the start in a part first year) ---
    const monthlyTarget = targetForYear(income, y) / 12;
    for (let m = firstMonth; m < 12; m++) {
      const monthDate = addMonths(yearStart, m);

      // Growth on investments and savings interest.
      const gd: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const id of PERSONS) {
        const acc = state.balances[id];
        const isaG = acc.isa * mInv;
        const penG = acc.pension * mInv;
        const giaG = acc.gia * mInv;
        // Interest only accrues on money actually held: an overdrawn balance earns nothing
        // (it must not become negative taxable savings income).
        const savG = Math.max(0, acc.savings) * mSav;
        acc.isa += isaG;
        acc.pension += penG;
        acc.gia += giaG;
        acc.savings += savG;
        accum.savingsIncome[id] += savG;
        // Premium Bond prizes are tax-free (never savings income); they are reinvested up to the
        // £50,000 holding limit and paid out as cash beyond it.
        const prize = Math.max(0, acc.premiumBonds) * mPB;
        const reinvest = Math.max(0, Math.min(prize, PREMIUM_BOND_LIMIT - acc.premiumBonds));
        acc.premiumBonds += reinvest;
        acc.savings += prize - reinvest;
        // GIA dividend portion of the total return is taxable (assumed reinvested). A yield
        // is paid out pro rata, not compounded, so the monthly slice is simply yield / 12.
        // Reinvesting it buys more holding, so it adds to the cost basis — otherwise it would
        // be taxed again as a gain when sold.
        const div = Math.max(0, acc.gia) * (scenario.rates.giaDividendYield / 12);
        accum.dividends[id] += div;
        acc.giaBasis += div;
        gd[id] = { isa: isaG, pension: penG, gia: giaG, savings: savG + prize };
      }
      txRow("Growth", toIso(monthDate), gd);

      const nextMonth = addMonths(yearStart, m + 1).getTime();

      // State pension credited monthly as cash (from the start date, the first month pro-rated);
      // taxable non-savings income for the year.
      {
        const sd: Deltas = {};
        for (const id of PERSONS) {
          const amt = statePensionInPeriod(spStart[id], monthDate, new Date(nextMonth), spRate[id]);
          if (amt > 0) {
            state.balances[id].savings += amt;
            accum.statePension[id] += amt;
            sd[id] = { savings: amt, income: amt };
          }
        }
        if (Object.keys(sd).length) txRow(INCOME_ROW_LABELS.statePension, toIso(monthDate), sd);
      }

      // Final employment income landing this month: earnings of this tax year.
      if (!finalIncomeHandled && fiAt >= monthDate.getTime() && fiAt < nextMonth) {
        for (const id of PERSONS) {
          const { net, tax } = fi.perPerson[id];
          state.balances[id].savings += net;
          accum.taxableNonSavings[id] += net + tax;
          oneOffIncome[id] += net + tax;
          accum.paidAtSource[id] += tax;
        }
        if (hasNetOrTax) txRow(INCOME_ROW_LABELS.finalIncome, fi.date, fiRow());
        const drawn = (id: PersonId) =>
          [...years.flatMap((ys) => ys.withdrawals), ...withdrawals].some(
            (w) => w.person === id && w.source === "pension" && w.gross > 0,
          );
        payEmployerPension(drawn);
        finalIncomeHandled = true;
      }

      // Real gilts' coupons and redemptions this month (before the draw they help fund).
      realGiltEvents(toIso(monthDate), toIso(new Date(nextMonth)));

      // Draw the monthly income need from the buffer (split evenly): cash first, then gilts.
      // Each pot that moves is booked to its owner, the income to the person drawing.
      const perPerson = monthlyTarget / 2;
      const inc: Deltas = {};
      for (const id of PERSONS) {
        const d = drawFromBuffer(state, id, perPerson, salePrice(toIso(monthDate)));
        addDelta(inc, id, "income", d.drawn);
        for (const q of PERSONS) {
          addDelta(inc, q, "savings", -d.cash[q]);
          addDelta(inc, q, "giltsTotal", -d.gilts[q]);
          disposals.giltSales[q] += d.gilts[q];
          // Accrued interest in a real gilt's sale price is taxable (Accrued Income Scheme).
          accum.savingsIncome[q] += d.accruedIncome[q];
        }
        const short = perPerson - d.drawn;
        if (short > 0.01) {
          const s = shortfalls.get(y) ?? { amount: 0, firstMonthIso: toIso(monthDate) };
          s.amount += short;
          shortfalls.set(y, s);
        }
      }
      txRow(INCOME_ROW_LABELS.drawdown, toIso(monthDate), inc);

      // One-off purchases falling in this month: raise the cash by selling investments
      // (tax-efficiently, so the tax lands in this year), then pay the purchase out of cash.
      for (const pur of purchases) {
        if (pur.at < monthDate.getTime() || pur.at >= nextMonth) continue;
        handledPurchases.add(pur.id);
        const raised = fundCash(pur.amount, `Fund: ${pur.label}`, toIso(monthDate));
        const spent = spendCash(state, pur.amount);
        txRow(`Purchase: ${pur.label}`, toIso(monthDate), {
          nick: { savings: -spent.nick },
          tracy: { savings: -spent.tracy },
        });
        if (raised < pur.amount - 1) {
          warnings.push(
            `Purchase "${pur.label}" (${Math.round(pur.amount)}) could not be fully funded from investments in ${y}/${y + 1}.`,
          );
        }
      }

      // Valued at the end of the month's window, after its events.
      balanceRow("Balance", toIso(monthDate), addDays(toIso(new Date(nextMonth)), -1));
    }

    // At year end the buffer counts a real gilt funding a year within its window as the cash it
    // will deliver — the nominal plus its remaining coupons — and one beyond it at market value
    // (what it would sell for); the engine's own gilts at par. (Counted at nominal alone, a gilt
    // bought with accrued interest would shrink the buffer, though that interest comes back
    // with its next coupon.)
    const bufferWindowEnd = y + Math.ceil(scenario.strategy.bufferYears);
    const yearEndIso = toIso(yearEnd);
    const bufferValue = (g: GiltHolding): number => {
      if (!isRealGilt(g)) return g.nominal;
      if (g.maturityYear > bufferWindowEnd) return holdingValue(g, yearEndIso);
      const terms = termsOf(g);
      return g.nominal * (1 + (couponPer100(terms) * remainingCoupons(terms, yearEndIso).length) / 100);
    };

    // --- Year-end (5 April y+1): crystallise, refill buffer, buy gilts, compute tax ---
    if (scenario.strategy.autoStrategy) {
      const target = bufferTarget(netNeed, scenario.strategy, y + 1);

      // 1. Proactive crystallisation, before the refill so one refill covers its tax: lifetime
      //    mode fills each person's taxable income to the searched fraction of the basic band;
      //    the heuristic's "fill the personal allowance" draws pension up to the allowance even
      //    when the cash isn't needed. Either way the year's savings and dividends count towards
      //    the ceiling, and the proceeds go to cash.
      const fraction = scenario.strategy.lifetimeFillFraction;
      const ceiling =
        mode === "lifetime" && fraction != null && fraction >= 0
          ? p.personalAllowance + fraction * p.basicRateBand
          : mode === "heuristic" && scenario.strategy.fillPersonalAllowanceFromPension
            ? p.personalAllowance
            : null;
      const crystallised: Record<PersonId, number> = { nick: 0, tracy: 0 };
      if (ceiling != null) {
        const topUp = lifetimeTopUp(state, buildPlans(yearEnd), ceiling);
        const deltas: Deltas = {};
        for (const w of topUp) {
          const acc = state.balances[w.person];
          acc.pension -= w.gross;
          acc.lsaRemaining -= w.lsaUsed;
          acc.savings += w.gross;
          accum.taxableNonSavings[w.person] += w.taxableNonSavings;
          disposals.sales[w.person].pension += w.gross;
          withdrawals.push(w);
          crystallised[w.person] += w.gross;
          addDelta(deltas, w.person, "pension", -w.gross);
          addDelta(deltas, w.person, "savings", w.gross);
        }
        if (topUp.length) txRow("Pension crystallisation", toIso(yearEnd), deltas);
      }

      // 2. Refill so the buffer is back at target *after* this year's tax is paid from it —
      //    otherwise it starts every year short by the tax bill and cash can run out before
      //    the next refill.
      const plans = buildPlans(yearEnd);
      const raise = refillAmount(target);
      // Fixed (overridden) sales happen even when no refill is needed.
      const planned = refillSales(Math.max(0, raise), plans);
      if (planned.length) applyPlanned(planned, "Refill: sell investments", toIso(yearEnd));

      // 3. Crystallised cash the buffer doesn't need is sheltered — the ISA up to its remaining
      //    allowance, then the GIA at cost — rather than left idle as cash.
      const surplus = Math.min(
        crystallised.nick + crystallised.tracy,
        currentBuffer(state, bufferValue) - target - Math.max(0, taxDue()),
      );
      if (surplus > 1) {
        const deltas: Deltas = {};
        const total = crystallised.nick + crystallised.tracy;
        for (const id of PERSONS) {
          const acc = state.balances[id];
          const amount = Math.min(Math.max(0, acc.savings), surplus * (crystallised[id] / total));
          if (amount <= 1) continue;
          const toIsa = Math.min(amount, isaRoom[id]);
          isaRoom[id] -= toIsa;
          acc.savings -= amount;
          acc.isa += toIsa;
          acc.gia += amount - toIsa;
          acc.giaBasis += amount - toIsa;
          addDelta(deltas, id, "savings", -amount);
          addDelta(deltas, id, "isa", toIsa);
          addDelta(deltas, id, "gia", amount - toIsa);
        }
        if (Object.keys(deltas).length) txRow("Shelter surplus cash (ISA, then GIA)", toIso(yearEnd), deltas);
      }

      // Gilt ladder purchases (cash -> gilts). Each person's tax is paid from their cash just
      // below, so it is reserved per person — that also stops the ladder buying a person's
      // rung with cash they need for their own tax bill.
      const taxNow = assessTax();
      const realMarket: RealGiltMarket | undefined = buyRealGilts
        ? {
            pricing,
            byFundsYear: buyable,
            purchaseIso: toIso(yearEnd),
            selection: scenario.strategy.giltSelection ?? "netYield",
            taxRate: { nick: marginalSavingsRate("nick"), tracy: marginalSavingsRate("tracy") },
          }
        : undefined;
      const purchases = planGiltPurchases(
        state,
        netNeed,
        scenario.rates,
        scenario.strategy,
        y + 1,
        { nick: Math.max(0, taxNow.nick.due), tracy: Math.max(0, taxNow.tracy.due) },
        realMarket,
      );
      if (purchases.length) {
        const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
        const maturityYears = new Set<number>();
        const realLabels: string[] = [];
        for (const gp of purchases) {
          const acc = state.balances[gp.holder];
          if (gp.real) {
            // A real gilt: paid for at its price (clean + accrued); the accrued interest bought
            // relieves its first coupon.
            const r = gp.real;
            let nominal = gp.nominal;
            if ((nominal * r.dirty) / 100 > acc.savings) nominal = Math.floor((Math.max(0, acc.savings) * 100) / r.dirty);
            const cost = (nominal * r.dirty) / 100;
            if (cost < 100) continue;
            acc.savings -= cost;
            state.gilts.push({
              id: `g${state.giltCounter++}`,
              holder: gp.holder,
              name: r.name,
              nominal,
              couponRate: gp.couponRate,
              cost,
              purchaseYear: y + 1,
              maturityYear: gp.maturityYear,
              isin: r.isin,
              redemptionIso: r.redemptionIso,
              aisCredit: Math.max(0, (nominal * r.accrued) / 100),
            });
            gilts.push({
              holder: gp.holder,
              name: r.name,
              nominal,
              couponRate: gp.couponRate,
              purchaseDateIso: toIso(yearEnd),
              maturityDateIso: r.redemptionIso,
              initial: false,
              isin: r.isin,
              cleanPrice: r.clean,
              cost,
              grossYield: r.grossYield,
              netYield: r.netYield,
              taxRate: r.taxRate,
            });
            const label = `${r.name}, matures ${shortDateIso(r.redemptionIso)}`;
            if (!realLabels.includes(label)) realLabels.push(label);
            const d = (deltas[gp.holder] ??= {});
            d.savings = (d.savings ?? 0) - cost;
            d.giltsTotal = (d.giltsTotal ?? 0) + cost;
            continue;
          }
          const spend = Math.min(gp.nominal, acc.savings);
          if (spend < 100) continue;
          acc.savings -= spend;
          state.gilts.push({
            id: `g${state.giltCounter++}`,
            holder: gp.holder,
            name: `G${gp.maturityYear}`,
            nominal: spend,
            couponRate: gp.couponRate,
            cost: spend,
            purchaseYear: y + 1,
            maturityYear: gp.maturityYear,
          });
          gilts.push({
            holder: gp.holder,
            name: `G${gp.maturityYear}`,
            nominal: spend,
            couponRate: gp.couponRate,
            purchaseDateIso: toIso(yearEnd),
            maturityDateIso: maturityIso(gp.maturityYear),
            initial: false,
          });
          maturityYears.add(gp.maturityYear);
          const d = (deltas[gp.holder] ??= {});
          d.savings = (d.savings ?? 0) - spend;
          d.giltsTotal = (d.giltsTotal ?? 0) + spend;
        }
        if (Object.keys(deltas).length) {
          const matLabel = [...maturityYears]
            .sort()
            .map((yr) => shortDateIso(maturityIso(yr)))
            .join(", ");
          const label =
            realLabels.length === 0
              ? `Gilt Purchase (matures ${matLabel})`
              : `Gilt Purchase (${[...realLabels, ...(maturityYears.size ? [`fictional, matures ${matLabel}`] : [])].join("; ")})`;
          txRow(label, toIso(yearEnd), deltas);
        }
      }
    }

    // --- Tax for the year ---
    const yearTax = assessTax();
    for (const id of PERSONS) disposals.realisedGain[id] = round2(accum.realisedGain[id]);
    // Settle what is still due after PAYE (a negative amount is a refund into cash).
    const paid = payTax(state, { nick: yearTax.nick.due, tracy: yearTax.tracy.due });
    const taxDeltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
    // The Tax column sums to the year's liability: PAYE shows on the Final Income row, the rest here.
    for (const id of PERSONS) taxDeltas[id] = { savings: -paid[id], tax: yearTax[id].due };
    txRow("Tax", toIso(yearEnd), taxDeltas);
    balanceRow("Year End", toIso(yearEnd));

    const bufTargetVal = bufferTarget(netNeed, scenario.strategy, y + 1);
    const nw = rows[rows.length - 1].netWorth;
    if (nw <= 0 && !warnings.some((w) => w.includes("depleted"))) {
      warnings.push(`Portfolio depleted around tax year ${y}/${y + 1}.`);
    }
    let deferredPensionTax = 0;
    for (const id of PERSONS) {
      const acc = state.balances[id];
      if (acc.pension <= 1) continue;
      const slice = pensionTaxable(acc.pension, acc.lsaRemaining) / 10;
      const sp = statePensionForYear(scenario.people[id], y + 1, modelStartYear, spGrowth);
      const base = { savings: 0, dividends: 0, gain: 0 };
      deferredPensionTax +=
        10 * (personYearTax({ ...base, nonSavings: sp + slice }, p).total - personYearTax({ ...base, nonSavings: sp }, p).total);
    }
    years.push({
      taxYearStart: y,
      nickAge: ageAtTaxYearStart(scenario.people.nick.dob, y),
      tracyAge: ageAtTaxYearStart(scenario.people.tracy.dob, y),
      incomeTarget: targetForYear(income, y),
      bufferTargetValue: bufTargetVal,
      bufferEnd: currentBuffer(state, bufferValue),
      netWorthEnd: nw,
      tax: yearTax,
      withdrawals,
      giltPurchasesValue: giltValue(state),
      disposals,
      deferredPensionTax: round2(deferredPensionTax),
      netWorthAfterPensionTax: round2(nw - deferredPensionTax),
    });
  }

  warnings.push(...shortfallWarnings(shortfalls));
  if (!finalIncomeHandled) {
    warnings.push(`The final income on ${fi.date} falls after the modelled period and is ignored.`);
  }
  for (const pur of purchases) {
    if (handledPurchases.has(pur.id)) continue;
    warnings.push(
      `Purchase "${pur.label}" on ${pur.date} falls outside the modelled period and is ignored.`,
    );
  }

  return { rows, years, warnings, gilts };
}

const gbp = (x: number) => `£${Math.round(x).toLocaleString("en-GB")}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One warning naming every tax year whose income draw came up short, with how much and
 *  when it started, so a trivial gap reads differently from a serious one. */
function shortfallWarnings(shortfalls: Map<number, { amount: number; firstMonthIso: string }>): string[] {
  if (shortfalls.size === 0) return [];
  const years = [...shortfalls.entries()].sort((a, b) => a[0] - b[0]);
  const shown = years.slice(0, 5).map(([y, s]) => {
    const [yy, mm] = s.firstMonthIso.split("-").map(Number);
    return `${y}/${String(y + 1).slice(2)} (${gbp(s.amount)} short from ${MONTHS[mm - 1]} ${yy})`;
  });
  const total = years.reduce((t, [, s]) => t + s.amount, 0);
  const more = years.length > shown.length ? `, and ${years.length - shown.length} more year(s)` : "";
  return [
    `Income cash ran short by ${gbp(total)} in total: ${shown.join(", ")}${more}. ` +
      `The buffer may be too small, or investments are running out.`,
  ];
}

/**
 * Proactive crystallisation: draw each accessible person's pension until their taxable
 * income (non-savings plus the year's savings and dividends) reaches `ceiling`, so unused
 * low-rate band each year is used to extract pension. Returns the withdrawals; the caller
 * banks the cash, refills, then shelters any surplus.
 */
function lifetimeTopUp(
  state: SimState,
  plans: Record<PersonId, ReturnType<typeof makePlan>>,
  ceiling: number,
): Withdrawal[] {
  const out: Withdrawal[] = [];
  for (const id of PERSONS) {
    const plan = plans[id];
    if (!plan.pensionAccessible) continue;
    // Savings and dividends count towards the ceiling too: they sit on top of the pension.
    const room = ceiling - plan.runningNonSavings - plan.otherIncome;
    if (room <= 1) continue;
    const pot = state.balances[id].pension;
    if (pot <= 1) continue;
    const gross = Math.min(pot, pensionGrossForTaxable(room, plan.lsaRemaining));
    if (gross <= 1) continue;
    const lsaUsed = lsaUsedBy(gross, plan.lsaRemaining);
    plan.lsaRemaining -= lsaUsed;
    plan.runningNonSavings += gross - lsaUsed;
    out.push({
      person: id,
      source: "pension",
      gross,
      taxableNonSavings: gross - lsaUsed,
      realisedGain: 0,
      lsaUsed,
      decisionKey: `topup:${id}`,
    });
  }
  return out;
}

/**
 * A person's sale plan for a sale on `onDate`. Pension access is judged on that date (the
 * year-end refill is on 5 April, so a birthday during the year counts); the GIA's gain
 * fraction is the live one from its tracked cost basis; the CGT exempt amount is what the
 * year's earlier disposals (Bed & ISA, purchases) have left.
 */
function mkPlan(
  id: PersonId,
  scenario: Scenario,
  state: SimState,
  onDate: Date,
  p: ReturnType<typeof resolveTaxParams>,
  income: { nonSavings: number; other: { savings: number; dividends: number }; gainSoFar: number },
) {
  const accessible = ageOn(scenario.people[id].dob, onDate) >= scenario.people[id].pensionAccessAge;
  const gainFraction = giaGainFraction(state.balances[id]);
  const lsa = state.balances[id].lsaRemaining;
  return makePlan(id, accessible, income.nonSavings, gainFraction, p, income.other, income.gainSoFar, lsa);
}

/** Apply a withdrawal to the balances; returns the capital gain it realised (GIA only, from
 *  the tracked cost basis — gilts are CGT-exempt). */
function applyWithdrawal(state: SimState, w: Withdrawal): number {
  const acc = state.balances[w.person];
  let gain = 0;
  if (w.source === "pension") {
    acc.pension -= w.gross;
    acc.lsaRemaining -= w.lsaUsed;
  } else if (w.source === "isa") acc.isa -= w.gross;
  else if (w.source === "gia") gain = sellGia(acc, w.gross).gain;
  else if (w.source === "gilt") sellGilts(state, w.person, w.gross);
  acc.savings += w.gross;
  return gain;
}

/**
 * Pay each person's tax bill from cash: their own first, then any shortfall from their
 * spouse's — the household's cash is drawn jointly, as the monthly income draw already is —
 * so neither person is overdrawn while the couple has the money. Only if both are short is
 * the remainder overdrawn on the liable person. Returns the cash taken from each person.
 */
function payTax(state: SimState, bill: Record<PersonId, number>): Record<PersonId, number> {
  const taken: Record<PersonId, number> = { nick: 0, tracy: 0 };
  const short: Record<PersonId, number> = { nick: 0, tracy: 0 };
  for (const id of PERSONS) {
    if (bill[id] < 0) {
      // A refund (PAYE overpaid at source) comes back into the person's own cash.
      state.balances[id].savings -= bill[id];
      taken[id] += bill[id];
      continue;
    }
    const own = Math.min(bill[id], Math.max(0, state.balances[id].savings));
    state.balances[id].savings -= own;
    taken[id] += own;
    short[id] = bill[id] - own;
  }
  for (const id of PERSONS) {
    if (short[id] <= 0) continue;
    const other: PersonId = id === "nick" ? "tracy" : "nick";
    const cover = Math.min(short[id], Math.max(0, state.balances[other].savings));
    state.balances[other].savings -= cover;
    taken[other] += cover;
    // Then Premium Bonds (own, then spouse's) before overdrawing the liable person.
    let rest = short[id] - cover;
    for (const who of [id, other]) {
      const fromPB = Math.min(rest, Math.max(0, state.balances[who].premiumBonds));
      state.balances[who].premiumBonds -= fromPB;
      taken[who] += fromPB;
      rest -= fromPB;
    }
    state.balances[id].savings -= rest;
    taken[id] += rest;
  }
  return taken;
}

/**
 * Take up to `amount` from the couple's cash in order — each listed person's plain cash, then
 * each one's Premium Bonds (cash-like, but their prizes are tax-free, so they are kept longest).
 * Adds what came from each person to `taken`; returns what is still owed.
 */
function takeCash(state: SimState, order: PersonId[], amount: number, taken: Record<PersonId, number>): number {
  let remaining = amount;
  for (const pot of ["savings", "premiumBonds"] as const) {
    for (const who of order) {
      if (remaining <= 0.005) return remaining;
      const take = Math.min(remaining, Math.max(0, state.balances[who][pot]));
      state.balances[who][pot] -= take;
      taken[who] += take;
      remaining -= take;
    }
  }
  return remaining;
}

/** Remove `amount` of cash from the couple's savings (nick first, then tracy). */
function spendCash(state: SimState, amount: number): Record<PersonId, number> {
  const taken: Record<PersonId, number> = { nick: 0, tracy: 0 };
  const short = takeCash(state, ["nick", "tracy"], amount, taken);
  if (short > 0) {
    // Overdraw (the plan can't fully fund it) — surfaced as a warning.
    state.balances.nick.savings -= short;
    taken.nick += short;
  }
  return taken;
}

/**
 * Draw a person's monthly income from the buffer: own cash, then the spouse's cash, then own
 * gilts, then the spouse's gilts (nearest maturity first; the engine's own at par, real ones at
 * `price`) — gilts are part of the buffer precisely so income keeps flowing when cash runs out
 * before the next refill. Returns the amount drawn and where it came from, so the ledger books
 * each pot to its owner, and the accrued interest sold with real gilts (taxable).
 */
function drawFromBuffer(
  state: SimState,
  id: PersonId,
  amount: number,
  price?: GiltSalePrice,
): {
  drawn: number;
  cash: Record<PersonId, number>;
  gilts: Record<PersonId, number>;
  accruedIncome: Record<PersonId, number>;
} {
  const other: PersonId = id === "nick" ? "tracy" : "nick";
  const cash: Record<PersonId, number> = { nick: 0, tracy: 0 };
  const gilts: Record<PersonId, number> = { nick: 0, tracy: 0 };
  const accruedIncome: Record<PersonId, number> = { nick: 0, tracy: 0 };
  let remaining = takeCash(state, [id, other], amount, cash);
  for (const who of [id, other]) {
    if (remaining <= 0.005) break;
    const sold = sellGilts(state, who, remaining, price);
    gilts[who] += sold.proceeds;
    accruedIncome[who] += sold.accruedIncome;
    remaining -= sold.proceeds;
  }
  return { drawn: amount - remaining, cash, gilts, accruedIncome };
}

function blankTax(): PersonTax {
  return {
    incomeTax: 0,
    cgt: 0,
    total: 0,
    paidAtSource: 0,
    due: 0,
    taxableNonSavings: 0,
    savingsIncome: 0,
    dividends: 0,
    realisedGain: 0,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
