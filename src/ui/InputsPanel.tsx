import { useEffect, useMemo, useState } from "react";
import type { PersonId, Scenario } from "../model/types";
import { useStore } from "../store/scenarioStore";
import { usePreRetirementStore } from "../store/preRetirementStore";
import { useExpenseStore } from "../store/expenseStore";
import { useGiltMarketStore } from "../store/giltMarketStore";
import { buildPricing } from "../gilts/pricing";
import { resolveLinkedBalances } from "../preretirement/link";
import { investableAssets, resolveIncome } from "../model/incomeTargets";
import { firstModelledTaxYear, isIsoDate } from "../tax/taxYear";
import { statutoryStatePensionAge } from "../tax/statePension";
import { LUMP_SUM_ALLOWANCE } from "../tax/pensionDraw";
import { money, pct } from "./format";

/** A date input that only commits real dates. Clearing it, or a half-typed value, stays a
 *  local draft (with a note) instead of writing "" into the scenario — an empty start date
 *  has no handoff month and used to hang the projection. */
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="field">
      <label>{label}</label>
      <span>
        <input
          type="date"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (isIsoDate(e.target.value)) onChange(e.target.value);
          }}
        />
        {!isIsoDate(draft) && (
          <span className="num-neg" style={{ fontSize: 12 }}>
            {" "}
            Enter a full date — still using {value}.
          </span>
        )}
      </span>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <span>
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        {suffix ? <span className="muted"> {suffix}</span> : null}
      </span>
    </div>
  );
}

function PctField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <NumField
      label={label}
      value={Math.round(value * 10000) / 100}
      step={0.1}
      suffix="%"
      onChange={(v) => onChange(v / 100)}
    />
  );
}

/** A number input where blank means "use the default" (null) — the default shows as the
 *  placeholder. `scale` converts a stored fraction to a displayed percentage (100). */
function OptionalNumField({
  label,
  value,
  placeholder,
  onChange,
  step = 1,
  scale = 1,
  suffix,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
  step?: number;
  scale?: number;
  suffix?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <span>
        <input
          type="number"
          step={step}
          placeholder={placeholder}
          value={value == null ? "" : Math.round(value * scale * 10000) / 10000}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            onChange(e.target.value.trim() === "" || !Number.isFinite(v) ? null : v / scale);
          }}
        />
        {suffix ? <span className="muted"> {suffix}</span> : null}
      </span>
    </div>
  );
}

/** "66y 7m" for a fractional age in years. */
function ageLabel(years: number): string {
  const y = Math.floor(years + 1e-9);
  const m = Math.round((years - y) * 12);
  return m === 0 ? `${y}` : `${y}y ${m}m`;
}

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <span>{value}</span>
    </div>
  );
}

export function InputsPanel() {
  const s = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const update = useStore((st) => st.update);
  const preData = usePreRetirementStore((st) => st.data);
  const expenseMonths = useExpenseStore((st) => st.data.months);
  const expenseTemplates = useExpenseStore((st) => st.data.templates);
  const giltMarket = useGiltMarketStore((st) => st.market);

  const linked = useMemo(
    () => (s.linkPreRetirement ? resolveLinkedBalances(s, preData, expenseMonths, expenseTemplates, giltMarket) : null),
    [s, preData, expenseMonths, expenseTemplates, giltMarket],
  );
  // Real gilts handed over by the link, at market value on the start date.
  const realGilts = useMemo(() => {
    const out: Record<PersonId, number> = { nick: 0, tracy: 0 };
    if (!linked) return out;
    const pricing = buildPricing(giltMarket);
    for (const g of linked.openingGilts) out[g.holder] += (g.nominal * pricing.dirty(g.isin, g, s.startDate, "sell")) / 100;
    return out;
  }, [linked, giltMarket, s.startDate]);

  const person = (id: PersonId) => {
    const set = (mut: (sc: Scenario) => void) => update(mut);
    const p = s.people[id];
    const b = s.balances[id];
    const lb = linked?.balances[id];
    return (
      <div className="card" key={id}>
        <h2 style={{ color: id === "nick" ? "var(--nick-text)" : "var(--tracy-text)" }}>{p.name}</h2>
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            value={p.name}
            onChange={(e) => set((sc) => (sc.people[id].name = e.target.value))}
          />
        </div>
        <div className="field">
          <label>Date of birth</label>
          <input
            type="date"
            value={p.dob}
            onChange={(e) => set((sc) => (sc.people[id].dob = e.target.value))}
          />
        </div>
        <NumField
          label="Pension access age"
          value={p.pensionAccessAge}
          onChange={(v) => set((sc) => (sc.people[id].pensionAccessAge = v))}
        />
        <OptionalNumField
          label="State pension age"
          value={p.statePensionAge}
          step={0.25}
          placeholder={isIsoDate(p.dob) ? `statutory: ${ageLabel(statutoryStatePensionAge(p.dob))}` : "statutory"}
          onChange={(v) => set((sc) => (sc.people[id].statePensionAge = v))}
        />
        <NumField
          label="State pension / yr (first year)"
          value={p.statePensionAnnual}
          step={100}
          onChange={(v) => set((sc) => (sc.people[id].statePensionAnnual = v))}
        />
        <NumField
          label="Lump sum allowance used"
          value={p.lumpSumAllowanceUsed}
          step={1000}
          onChange={(v) => set((sc) => (sc.people[id].lumpSumAllowanceUsed = Math.max(0, v)))}
        />
        <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
          Leave the State Pension age blank for the statutory date; the amount is per year in the first
          modelled tax year. Tax-free cash already taken counts against the {money(LUMP_SUM_ALLOWANCE)} Lump
          Sum Allowance — after it, pension draws are fully taxable.
        </p>
        <div className="section-title">Starting balances</div>
        {lb ? (
          <>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
              Projected by the Pre-retirement module as at the end of {s.startDate}.
            </p>
            <ValueRow label="ISA" value={money(lb.isa)} />
            <ValueRow label="Pension" value={money(lb.pension)} />
            <ValueRow label="GIA" value={money(lb.gia)} />
            <ValueRow label="Savings" value={money(lb.savings)} />
            <ValueRow label="Premium Bonds" value={money(lb.premiumBonds)} />
            <ValueRow label="Gilts" value={money(lb.gilts)} />
            {realGilts[id] > 0 && <ValueRow label="Gilts (DMO holdings)" value={money(realGilts[id])} />}
            <ValueRow label="GIA embedded gain" value={pct(lb.giaGainFraction)} />
          </>
        ) : (
          <>
            <NumField label="ISA" value={b.isa} step={1000} onChange={(v) => set((sc) => (sc.balances[id].isa = v))} />
            <NumField label="Pension" value={b.pension} step={1000} onChange={(v) => set((sc) => (sc.balances[id].pension = v))} />
            <NumField label="GIA" value={b.gia} step={1000} onChange={(v) => set((sc) => (sc.balances[id].gia = v))} />
            <NumField label="Savings" value={b.savings} step={1000} onChange={(v) => set((sc) => (sc.balances[id].savings = v))} />
            <NumField
              label="Premium Bonds"
              value={b.premiumBonds}
              step={1000}
              onChange={(v) => set((sc) => (sc.balances[id].premiumBonds = Math.max(0, v)))}
            />
            <NumField label="Gilts" value={b.gilts} step={1000} onChange={(v) => set((sc) => (sc.balances[id].gilts = v))} />
            <PctField label="GIA embedded gain" value={b.giaGainFraction} onChange={(v) => set((sc) => (sc.balances[id].giaGainFraction = v))} />
          </>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="card">
        <h2>Rates</h2>
        <PctField label="Investment growth" value={s.rates.investmentGrowth} onChange={(v) => update((sc) => (sc.rates.investmentGrowth = v))} />
        <PctField label="Savings interest" value={s.rates.savingsInterest} onChange={(v) => update((sc) => (sc.rates.savingsInterest = v))} />
        <PctField
          label="Premium Bond prize rate (tax-free)"
          value={s.rates.premiumBondRate}
          onChange={(v) => update((sc) => (sc.rates.premiumBondRate = v))}
        />
        <PctField label="Inflation" value={s.rates.inflation} onChange={(v) => update((sc) => (sc.rates.inflation = v))} />
        <PctField
          label={s.strategy.giltUniverse === "real" ? "Gilt coupon (fictional gilts, no DMO prices)" : "Gilt coupon"}
          value={s.rates.giltCoupon}
          onChange={(v) => update((sc) => (sc.rates.giltCoupon = v))}
        />
        <PctField
          label="Gilt yield shift (real gilts)"
          value={s.rates.giltYieldShift}
          onChange={(v) => update((sc) => (sc.rates.giltYieldShift = v))}
        />
        <PctField label="GIA dividend yield" value={s.rates.giaDividendYield} onChange={(v) => update((sc) => (sc.rates.giaDividendYield = v))} />
        <OptionalNumField
          label="State pension growth"
          value={s.rates.statePensionGrowth}
          scale={100}
          step={0.1}
          suffix="%"
          placeholder={`triple lock: ${Math.round(Math.max(s.rates.inflation, 0.025) * 1000) / 10}`}
          onChange={(v) => update((sc) => (sc.rates.statePensionGrowth = v))}
        />
      </div>

      <div className="card">
        <h2>Income target</h2>
        <div className="field-full">
          <label>Set year-1 income by</label>
          <select
            value={s.income.mode ?? "fixed"}
            onChange={(e) => update((sc) => (sc.income.mode = e.target.value as typeof sc.income.mode))}
          >
            <option value="fixed">Fixed amount</option>
            <option value="swr">Safe withdrawal rate of assets</option>
          </select>
        </div>
        {s.income.mode === "swr" ? (
          <>
            <PctField label="Withdrawal rate" value={s.income.swrRate ?? 0.035} onChange={(v) => update((sc) => (sc.income.swrRate = v))} />
            <div className="field">
              <label>Year-1 income</label>
              <span>
                {money(resolveIncome(s).baseAnnual)}
                <span className="muted"> ({money(investableAssets(s))} assets)</span>
              </span>
            </div>
          </>
        ) : (
          <NumField label="Base annual (yr 1)" value={s.income.baseAnnual} step={1000} onChange={(v) => update((sc) => (sc.income.baseAnnual = v))} />
        )}
        <ValueRow
          label="Start year"
          value={`${s.income.startYear}/${String(s.income.startYear + 1).slice(-2)} (from the start date)`}
        />
        <NumField label="Years to model" value={s.income.years} onChange={(v) => update((sc) => (sc.income.years = v))} />
        <PctField label={s.income.mode === "swr" ? "Income growth (after yr 1)" : "Income growth"} value={s.income.growth} onChange={(v) => update((sc) => (sc.income.growth = v))} />
        {s.income.mode === "swr" && (
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            {((s.income.swrRate ?? 0.035) * 100).toFixed(1)}% of investable assets (ISA + Pension + GIA,
            excluding savings &amp; gilts) at the start, then rising with income growth.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Strategy</h2>
        <NumField label="Buffer (years)" value={s.strategy.bufferYears} step={0.5} onChange={(v) => update((sc) => (sc.strategy.bufferYears = v))} />
        <NumField label="Gilt ladder (years)" value={s.strategy.giltLadderYears} onChange={(v) => update((sc) => (sc.strategy.giltLadderYears = v))} />
        <div className="field-full">
          <label>Gilts to buy</label>
          <select
            value={s.strategy.giltUniverse}
            onChange={(e) => update((sc) => (sc.strategy.giltUniverse = e.target.value as typeof sc.strategy.giltUniverse))}
          >
            <option value="real">Real gilts (DMO prices)</option>
            <option value="fictional">Fictional par gilts</option>
          </select>
        </div>
        {s.strategy.giltUniverse === "real" && (
          <div className="field-full">
            <label>Choose gilts by</label>
            <select
              value={s.strategy.giltSelection}
              onChange={(e) => update((sc) => (sc.strategy.giltSelection = e.target.value as typeof sc.strategy.giltSelection))}
            >
              <option value="netYield">Best yield after tax</option>
              <option value="lowestCoupon">Lowest coupon</option>
              <option value="grossYield">Best gross yield</option>
            </select>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>
          {s.strategy.giltUniverse === "real"
            ? s.strategy.giltSelection === "netYield"
              ? "Each rung is a real gilt redeeming in time for its year, chosen per person by yield after tax at their marginal rate on savings — low-coupon gilts when coupons would be taxed (their rise to par is CGT-free), the best gross yield within the allowances. Prices are modelled from today's DMO prices (plus the yield shift); a year no real gilt fits gets a fictional gilt at par."
              : s.strategy.giltSelection === "lowestCoupon"
                ? "Each rung is the lowest-coupon real gilt redeeming in time for its year (least taxable income). Prices are modelled from today's DMO prices (plus the yield shift); a year no real gilt fits gets a fictional gilt at par."
                : "Each rung is the real gilt with the best gross redemption yield redeeming in time for its year. Prices are modelled from today's DMO prices (plus the yield shift); a year no real gilt fits gets a fictional gilt at par."
            : "Each rung is a fictional gilt bought at par, paying the scenario's gilt coupon."}
        </p>
        <div className="field">
          <label>Auto strategy</label>
          <input type="checkbox" checked={s.strategy.autoStrategy} onChange={(e) => update((sc) => (sc.strategy.autoStrategy = e.target.checked))} />
        </div>
        <div className="field-full">
          <label>Sell strategy</label>
          <select
            value={s.strategy.taxMode}
            onChange={(e) => update((sc) => (sc.strategy.taxMode = e.target.value as typeof sc.strategy.taxMode))}
          >
            <option value="heuristic">Rules-based (priority order)</option>
            <option value="annual">Optimise: minimise each year's tax</option>
            <option value="lifetime">Optimise: minimise lifetime tax</option>
          </select>
        </div>
        {s.strategy.taxMode === "heuristic" && (
          <>
            <div className="field">
              <label>Fill personal allowance from pension</label>
              <input type="checkbox" checked={s.strategy.fillPersonalAllowanceFromPension} onChange={(e) => update((sc) => (sc.strategy.fillPersonalAllowanceFromPension = e.target.checked))} />
            </div>
            <div className="field">
              <label>Preserve ISA (draw taxable first)</label>
              <input type="checkbox" checked={s.strategy.preserveIsa} onChange={(e) => update((sc) => (sc.strategy.preserveIsa = e.target.checked))} />
            </div>
          </>
        )}
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          {s.strategy.taxMode === "heuristic" &&
            "Fixed tax-aware order: fill allowances, use CGT exemption, preserve ISA."}
          {s.strategy.taxMode === "annual" &&
            "True optimiser: picks the split of pension / GIA / ISA sales with the lowest tax in each single year (marginal-cost greedy)."}
          {s.strategy.taxMode === "lifetime" &&
            "Searches how far to crystallise pension into ISA each year to minimise total tax across the whole forecast."}
        </p>
      </div>

      <div className="card">
        <h2>Starting position &amp; final income</h2>
        <DateField
          label="Model start date"
          value={s.startDate}
          onChange={(v) =>
            update((sc) => {
              sc.startDate = v;
              // The model starts the day after; its tax year is the income start year.
              sc.income.startYear = firstModelledTaxYear(v);
            })
          }
        />
        <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
          Starting balances are as at the end of this day; the forecast runs from the next day (a
          mid-year start models a part first tax year).
        </p>
        <div className="field">
          <label>Married / civil partners</label>
          <input
            type="checkbox"
            checked={s.married}
            onChange={(e) => update((sc) => (sc.married = e.target.checked))}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Applies the marriage allowance in years when it saves tax (both partners within the basic rate).
        </p>
        <div className="field">
          <label>Link to pre-retirement forecast</label>
          <input
            type="checkbox"
            checked={s.linkPreRetirement}
            onChange={(e) => update((sc) => (sc.linkPreRetirement = e.target.checked))}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          {s.linkPreRetirement
            ? "Starting balances come live from the Pre-retirement module's projection at the model start date (Savings + Premium Bonds merge into Savings). The balance fields below are read-only while linked."
            : `Per-person opening balances are set in the ${s.people.nick.name} / ${s.people.tracy.name} cards below.`}
        </p>
        <div className="section-title">Final income (one-off, tax already paid)</div>
        <div className="field">
          <label>Date received</label>
          <input
            type="date"
            value={s.finalIncome.date}
            onChange={(e) => update((sc) => (sc.finalIncome.date = e.target.value))}
          />
        </div>
        {(["nick", "tracy"] as PersonId[]).map((id) => (
          <div key={id}>
            <div className="section-title" style={{ color: id === "nick" ? "var(--nick-text)" : "var(--tracy-text)" }}>
              {s.people[id].name}
            </div>
            <NumField
              label="Net received"
              value={s.finalIncome.perPerson[id].net}
              step={1000}
              onChange={(v) => update((sc) => (sc.finalIncome.perPerson[id].net = v))}
            />
            <NumField
              label="Tax already paid"
              value={s.finalIncome.perPerson[id].tax}
              step={1000}
              onChange={(v) => update((sc) => (sc.finalIncome.perPerson[id].tax = v))}
            />
          </div>
        ))}
      </div>

      {person("nick")}
      {person("tracy")}
    </div>
  );
}
