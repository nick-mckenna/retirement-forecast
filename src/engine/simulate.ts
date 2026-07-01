import type { PersonId, Scenario } from "../model/types";
import { annualToMonthly } from "../model/rates";
import { resolveIncome, targetForYear } from "../model/incomeTargets";
import { computeIncomeTax } from "../tax/incomeTax";
import { computeCGT } from "../tax/cgt";
import { statePensionForYear } from "../tax/statePension";
import { resolveTaxParams } from "../tax/taxParams";
import { ageAtTaxYearStart, addMonths, parseDate, toIso } from "../tax/taxYear";
import { bufferTarget, currentBuffer } from "../strategy/buffer";
import { makePlan, raiseCash, raiseCashMarginal, type Withdrawal } from "../strategy/drawdown";
import { planGiltPurchases } from "../strategy/giltLadder";
import { emptyPersonColumns, type LedgerRow, type PersonColumns } from "./ledger";
import { giltValue, initState, sellGia, type SimState } from "./state";

const PERSONS: PersonId[] = ["nick", "tracy"];

export interface PersonTax {
  incomeTax: number;
  cgt: number;
  total: number;
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
}

function newDisposals(): YearDisposals {
  return {
    sales: { nick: { pension: 0, gia: 0, isa: 0 }, tracy: { pension: 0, gia: 0, isa: 0 } },
    isaFill: { nick: 0, tracy: 0 },
    giltMaturities: { nick: 0, tracy: 0 },
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
}

export interface SimResult {
  rows: LedgerRow[];
  years: YearSummary[];
  warnings: string[];
  gilts: GiltRecord[];
}

/** Gilts mature at the start of their tax year (6 April). */
function maturityIso(maturityYear: number): string {
  return `${maturityYear}-04-06`;
}

function shortDateIso(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

interface Accum {
  taxableNonSavings: Record<PersonId, number>;
  savingsIncome: Record<PersonId, number>;
  dividends: Record<PersonId, number>;
  realisedGain: Record<PersonId, number>;
}

function newAccum(): Accum {
  return {
    taxableNonSavings: { nick: 0, tracy: 0 },
    savingsIncome: { nick: 0, tracy: 0 },
    dividends: { nick: 0, tracy: 0 },
    realisedGain: { nick: 0, tracy: 0 },
  };
}

export function simulate(scenario: Scenario): SimResult {
  const state = initState(scenario);
  const rows: LedgerRow[] = [];
  const years: YearSummary[] = [];
  const warnings: string[] = [];
  const gilts: GiltRecord[] = state.gilts.map((g) => ({
    holder: g.holder,
    name: g.name,
    nominal: g.nominal,
    couponRate: g.couponRate,
    purchaseDateIso: scenario.startDate,
    maturityDateIso: maturityIso(g.maturityYear),
    initial: true,
  }));

  const mInv = annualToMonthly(scenario.rates.investmentGrowth);
  const mSav = annualToMonthly(scenario.rates.savingsInterest);
  const startDate = parseDate(scenario.startDate);
  const income = resolveIncome(scenario);
  const modelStartYear = income.startYear;
  const overrideMap = new Map(scenario.overrides.map((o) => [o.key, o.amount]));
  const purchases = (scenario.purchases ?? []).map((pp) => ({ ...pp, at: parseDate(pp.date).getTime() }));

  const balanceRow = (label: string, dateIso: string): void => {
    const nick = snapshot("nick");
    const tracy = snapshot("tracy");
    const savingsAndGilts =
      nick.savings + tracy.savings + nick.giltsTotal + tracy.giltsTotal;
    const netWorth =
      nick.isa + nick.pension + nick.gia + nick.savings + nick.giltsTotal +
      tracy.isa + tracy.pension + tracy.gia + tracy.savings + tracy.giltsTotal;
    rows.push({ type: "BALANCE", label, dateIso, nick, tracy, savingsAndGilts, netWorth });
  };
  const snapshot = (id: PersonId): PersonColumns => {
    const b = state.balances[id];
    return {
      income: 0,
      isa: b.isa,
      pension: b.pension,
      gia: b.gia,
      savings: b.savings,
      giltsTotal: giltValue(state, id),
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

  // --- One-off final employment income (tax already paid) ---
  const fi = scenario.finalIncome;
  for (const id of PERSONS) state.balances[id].savings += fi.perPerson[id].net;
  txRow("Final Income", fi.date, {
    nick: { income: fi.perPerson.nick.net, savings: fi.perPerson.nick.net, tax: fi.perPerson.nick.tax },
    tracy: { income: fi.perPerson.tracy.net, savings: fi.perPerson.tracy.net, tax: fi.perPerson.tracy.tax },
  });
  balanceRow("After Final Income", fi.date);

  // --- Annual loop over tax years ---
  for (let i = 0; i < income.years; i++) {
    const y = income.startYear + i;
    const p = resolveTaxParams(scenario.taxParams, y, scenario.rates.inflation);
    const yearStart = new Date(Date.UTC(y, 3, 6)); // 6 April y
    const accum = newAccum();
    const withdrawals: Withdrawal[] = [];
    const disposals = newDisposals();

    // State pension (annual figure; credited monthly below).
    const statePension: Record<PersonId, number> = {
      nick: statePensionForYear(scenario.people.nick, y, modelStartYear, scenario.rates.inflation),
      tracy: statePensionForYear(scenario.people.tracy, y, modelStartYear, scenario.rates.inflation),
    };

    const mode = scenario.strategy.taxMode ?? "heuristic";

    // Apply a set of planned withdrawals to the state (balances, tax accumulators, disposals)
    // and emit a ledger row. Shared by the year-end refill and one-off purchase funding.
    const applyPlanned = (planned: Withdrawal[], label: string, dateIso: string) => {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const w of planned) {
        applyWithdrawal(state, w);
        accum.taxableNonSavings[w.person] += w.taxableNonSavings;
        accum.realisedGain[w.person] += w.realisedGain;
        if (w.source !== "gilt") disposals.sales[w.person][w.source] += w.gross;
        withdrawals.push(w);
        const d = (deltas[w.person] ??= {});
        d.savings = (d.savings ?? 0) + w.gross;
        const col: keyof PersonColumns = w.source === "gilt" ? "giltsTotal" : w.source;
        d[col] = (d[col] ?? 0) - w.gross;
      }
      if (planned.length) txRow(label, dateIso, deltas);
    };

    const buildPlans = () => ({
      nick: mkPlan("nick", scenario, y, statePension.nick + accum.taxableNonSavings.nick, p),
      tracy: mkPlan("tracy", scenario, y, statePension.tracy + accum.taxableNonSavings.tracy, p),
    });

    /** Raise `target` cash by selling investments tax-efficiently; returns the gross raised. */
    const fundCash = (target: number, label: string, dateIso: string): number => {
      if (target <= 1) return 0;
      const ctx = { plans: buildPlans(), config: scenario.strategy, year: y };
      const planned =
        mode === "heuristic"
          ? raiseCash(state, target, ctx)
          : raiseCashMarginal(state, target, ctx);
      applyPlanned(planned, label, dateIso);
      return planned.reduce((s, w) => s + w.gross, 0);
    };

    // Gilt maturities (redeem at par -> cash; capital gain CGT-exempt).
    const matured = state.gilts.filter((g) => g.maturityYear <= y);
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
      state.gilts = state.gilts.filter((g) => g.maturityYear > y);
      txRow("Gilt Maturity", toIso(yearStart), deltas);
    }

    // Gilt coupons (taxable savings income; paid into cash).
    if (state.gilts.length > 0) {
      const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const g of state.gilts) {
        const coupon = g.nominal * g.couponRate;
        state.balances[g.holder].savings += coupon;
        accum.savingsIncome[g.holder] += coupon;
        deltas[g.holder] = { savings: (deltas[g.holder]?.savings ?? 0) + coupon };
      }
      if (Object.keys(deltas).length) txRow("Gilt Coupon", toIso(yearStart), deltas);
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
      if (any) txRow("ISA Fill (Bed & ISA)", toIso(yearStart), deltas);
    }

    // --- 12 monthly steps ---
    const monthlyTarget = targetForYear(income, y) / 12;
    for (let m = 0; m < 12; m++) {
      const monthDate = addMonths(yearStart, m);

      // Growth on investments and savings interest.
      const gd: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const id of PERSONS) {
        const acc = state.balances[id];
        const isaG = acc.isa * mInv;
        const penG = acc.pension * mInv;
        const giaG = acc.gia * mInv;
        const savG = acc.savings * mSav;
        acc.isa += isaG;
        acc.pension += penG;
        acc.gia += giaG;
        acc.savings += savG;
        accum.savingsIncome[id] += savG;
        // GIA dividend portion of the total return is taxable (assumed reinvested).
        accum.dividends[id] += acc.gia * annualToMonthly(scenario.rates.giaDividendYield);
        gd[id] = { isa: isaG, pension: penG, gia: giaG, savings: savG };
      }
      txRow("Growth", toIso(monthDate), gd);

      // State pension credited monthly as cash. It is taxable non-savings income, but is
      // added to the tax calc once via `statePension[id]` at year end (see below) — do NOT
      // also accumulate it here, or it would be double-counted.
      if (statePension.nick > 0 || statePension.tracy > 0) {
        const sd: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
        for (const id of PERSONS) {
          const amt = statePension[id] / 12;
          if (amt > 0) {
            state.balances[id].savings += amt;
            sd[id] = { savings: amt, income: amt };
          }
        }
        txRow("State Pension", toIso(monthDate), sd);
      }

      // Draw the monthly income need from the cash buffer (split evenly).
      const perPerson = monthlyTarget / 2;
      const inc: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
      for (const id of PERSONS) {
        const drawn = drawFromBuffer(state, id, perPerson, warnings, y);
        inc[id] = { income: drawn, savings: -drawn };
      }
      txRow("Income", toIso(monthDate), inc);

      // One-off purchases falling in this month: raise the cash by selling investments
      // (tax-efficiently, so the tax lands in this year), then pay the purchase out of cash.
      const nextMonth = addMonths(yearStart, m + 1).getTime();
      for (const pur of purchases) {
        if (pur.at < monthDate.getTime() || pur.at >= nextMonth) continue;
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

      balanceRow("Balance", toIso(monthDate));
    }

    // --- Year-end (5 April y+1): refill buffer, buy gilts, compute tax ---
    const yearEnd = new Date(Date.UTC(y + 1, 3, 5));

    if (scenario.strategy.autoStrategy) {
      const plans = buildPlans();

      const shortfall = bufferTarget(income, scenario.strategy, y + 1) - currentBuffer(state);
      if (shortfall > 1) {
        const ctx = { plans, config: scenario.strategy, year: y };
        let planned =
          mode === "heuristic"
            ? raiseCash(state, shortfall, ctx)
            : raiseCashMarginal(state, shortfall, ctx);
        planned = applyOverrides(planned, overrideMap, y, scenario);
        applyPlanned(planned, "Refill: sell investments", toIso(yearEnd));
      }

      // Lifetime mode: proactively crystallise pension up to a taxable-income target and
      // shelter the net proceeds in the ISA (up to the remaining allowance), so pension is
      // extracted at low rates over time rather than bunched into higher-rate years later.
      const fraction = scenario.strategy.lifetimeFillFraction;
      if (mode === "lifetime" && fraction != null && fraction >= 0) {
        // Resolve the fill target against this year's bands so it scales with uprating.
        const ceiling = p.personalAllowance + fraction * p.basicRateBand;
        const topUp = lifetimeTopUp(state, plans, ceiling);
        const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
        for (const w of topUp) {
          const acc = state.balances[w.person];
          acc.pension -= w.gross; // crystallise pension
          accum.taxableNonSavings[w.person] += w.taxableNonSavings;
          disposals.sales[w.person].pension += w.gross;
          withdrawals.push(w);
          // Shelter the proceeds in the ISA up to the remaining allowance; rest to cash.
          const toIsa = Math.min(w.gross, isaRoom[w.person]);
          acc.isa += toIsa;
          acc.savings += w.gross - toIsa;
          isaRoom[w.person] -= toIsa;
          const d = (deltas[w.person] ??= {});
          d.pension = (d.pension ?? 0) - w.gross;
          d.isa = (d.isa ?? 0) + toIsa;
          d.savings = (d.savings ?? 0) + (w.gross - toIsa);
        }
        if (topUp.length) txRow("Pension crystallisation -> ISA", toIso(yearEnd), deltas);
      }

      // Gilt ladder purchases (cash -> gilts).
      const purchases = planGiltPurchases(state, income, scenario.rates, scenario.strategy, y + 1);
      if (purchases.length) {
        const deltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
        const maturityYears = new Set<number>();
        for (const gp of purchases) {
          const acc = state.balances[gp.holder];
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
          txRow(`Gilt Purchase (matures ${matLabel})`, toIso(yearEnd), deltas);
        }
      }
    }

    // --- Tax for the year ---
    const yearTax: Record<PersonId, PersonTax> = { nick: blankTax(), tracy: blankTax() };
    const taxDeltas: Partial<Record<PersonId, Partial<PersonColumns>>> = {};
    for (const id of PERSONS) {
      const parts = {
        nonSavings: accum.taxableNonSavings[id] + statePension[id],
        savings: accum.savingsIncome[id],
        dividends: accum.dividends[id],
      };
      const it = computeIncomeTax(parts, p);
      const basicBandRemaining = Math.max(0, p.personalAllowance + p.basicRateBand - it.taxableTotal);
      const cgt = computeCGT(accum.realisedGain[id], basicBandRemaining, p);
      disposals.realisedGain[id] = round2(accum.realisedGain[id]);
      const total = round2(it.tax + cgt.tax);
      yearTax[id] = {
        incomeTax: it.tax,
        cgt: cgt.tax,
        total,
        taxableNonSavings: round2(parts.nonSavings),
        savingsIncome: round2(parts.savings),
        dividends: round2(parts.dividends),
        realisedGain: round2(accum.realisedGain[id]),
      };
      // Pay the tax out of cash.
      state.balances[id].savings -= total;
      taxDeltas[id] = { savings: -total, tax: total };
    }
    txRow("Tax", toIso(yearEnd), taxDeltas);
    balanceRow("Year End", toIso(yearEnd));

    const bufTargetVal = bufferTarget(income, scenario.strategy, y + 1);
    const nw = rows[rows.length - 1].netWorth;
    if (nw <= 0 && !warnings.some((w) => w.includes("depleted"))) {
      warnings.push(`Portfolio depleted around tax year ${y}/${y + 1}.`);
    }
    years.push({
      taxYearStart: y,
      nickAge: ageAtTaxYearStart(scenario.people.nick.dob, y),
      tracyAge: ageAtTaxYearStart(scenario.people.tracy.dob, y),
      incomeTarget: targetForYear(income, y),
      bufferTargetValue: bufTargetVal,
      bufferEnd: currentBuffer(state),
      netWorthEnd: nw,
      tax: yearTax,
      withdrawals,
      giltPurchasesValue: giltValue(state),
      disposals,
    });
  }

  return { rows, years, warnings, gilts };
}

/**
 * Lifetime mode: draw each accessible person's pension up to a taxable-income `ceiling`
 * (beyond what the refill already drew), so unused low-rate band each year is used to
 * extract pension. Returns the extra pension withdrawals (the caller shelters the cash).
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
    const room = ceiling - plan.runningNonSavings;
    if (room <= 1) continue;
    const pot = state.balances[id].pension;
    if (pot <= 1) continue;
    const gross = Math.min(pot, room / 0.75);
    if (gross <= 1) continue;
    plan.runningNonSavings += gross * 0.75;
    out.push({
      person: id,
      source: "pension",
      gross,
      taxableNonSavings: gross * 0.75,
      realisedGain: 0,
      decisionKey: `topup:${id}`,
    });
  }
  return out;
}

function mkPlan(
  id: PersonId,
  scenario: Scenario,
  taxYearStart: number,
  preexistingNonSavings: number,
  p: ReturnType<typeof resolveTaxParams>,
) {
  const acc = scenario.balances[id];
  const age = ageAtTaxYearStart(scenario.people[id].dob, taxYearStart);
  const accessible = age >= scenario.people[id].pensionAccessAge;
  const gainFraction = acc.giaGainFraction;
  return makePlan(id, accessible, preexistingNonSavings, gainFraction, p);
}

function applyWithdrawal(state: SimState, w: Withdrawal): void {
  const acc = state.balances[w.person];
  if (w.source === "pension") acc.pension -= w.gross;
  else if (w.source === "isa") acc.isa -= w.gross;
  else if (w.source === "gia") sellGia(acc, w.gross);
  acc.savings += w.gross;
}

/** Remove `amount` of cash from the couple's savings (nick first, then tracy). */
function spendCash(state: SimState, amount: number): Record<PersonId, number> {
  const nickAvail = Math.max(0, state.balances.nick.savings);
  const tracyAvail = Math.max(0, state.balances.tracy.savings);
  let nick = Math.min(amount, nickAvail);
  let tracy = Math.min(amount - nick, tracyAvail);
  const short = amount - nick - tracy;
  if (short > 0) nick += short; // overdraw (plan can't fully fund it) — surfaced as a warning
  state.balances.nick.savings -= nick;
  state.balances.tracy.savings -= tracy;
  return { nick, tracy };
}

/** Aggregate the auto plan by person+source and let user overrides replace amounts. */
function applyOverrides(
  planned: Withdrawal[],
  overrides: Map<string, number>,
  year: number,
  scenario: Scenario,
): Withdrawal[] {
  const byKey = new Map<string, Withdrawal>();
  for (const w of planned) {
    const key = `${year}:${w.person}:${w.source}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.gross += w.gross;
      cur.taxableNonSavings += w.taxableNonSavings;
      cur.realisedGain += w.realisedGain;
    } else {
      byKey.set(key, { ...w, decisionKey: key });
    }
  }
  for (const [key, w] of byKey) {
    if (overrides.has(key)) {
      const amt = overrides.get(key)!;
      w.gross = amt;
      w.taxableNonSavings = w.source === "pension" ? amt * 0.75 : 0;
      w.realisedGain = w.source === "gia" ? amt * scenario.balances[w.person].giaGainFraction : 0;
    }
  }
  return [...byKey.values()];
}

function drawFromBuffer(
  state: SimState,
  id: PersonId,
  amount: number,
  warnings: string[],
  year: number,
): number {
  const acc = state.balances[id];
  const fromSelf = Math.min(amount, Math.max(0, acc.savings));
  acc.savings -= fromSelf;
  let remaining = amount - fromSelf;
  if (remaining > 0.01) {
    // Fall back to spouse's cash.
    const other = id === "nick" ? "tracy" : "nick";
    const fromOther = Math.min(remaining, Math.max(0, state.balances[other].savings));
    state.balances[other].savings -= fromOther;
    remaining -= fromOther;
  }
  if (remaining > 1 && !warnings.some((w) => w.includes(`cash ran short`))) {
    warnings.push(`Income cash ran short in tax year ${year}/${year + 1}; buffer may be too small.`);
  }
  return amount - remaining;
}

function blankTax(): PersonTax {
  return {
    incomeTax: 0,
    cgt: 0,
    total: 0,
    taxableNonSavings: 0,
    savingsIncome: 0,
    dividends: 0,
    realisedGain: 0,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
