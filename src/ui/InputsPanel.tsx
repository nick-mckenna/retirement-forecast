import type { PersonId, Scenario } from "../model/types";
import { useStore } from "../store/scenarioStore";
import { investableAssets, resolveIncome } from "../model/incomeTargets";
import { money } from "./format";

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

export function InputsPanel() {
  const s = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const update = useStore((st) => st.update);

  const person = (id: PersonId) => {
    const set = (mut: (sc: Scenario) => void) => update(mut);
    const p = s.people[id];
    const b = s.balances[id];
    return (
      <div className="card" key={id}>
        <h2 style={{ color: id === "nick" ? "var(--nick)" : "var(--tracy)" }}>{p.name}</h2>
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
        <NumField
          label="State pension age"
          value={p.statePensionAge}
          onChange={(v) => set((sc) => (sc.people[id].statePensionAge = v))}
        />
        <NumField
          label="State pension / yr"
          value={p.statePensionAnnual}
          step={100}
          onChange={(v) => set((sc) => (sc.people[id].statePensionAnnual = v))}
        />
        <div className="section-title">Starting balances</div>
        <NumField label="ISA" value={b.isa} step={1000} onChange={(v) => set((sc) => (sc.balances[id].isa = v))} />
        <NumField label="Pension" value={b.pension} step={1000} onChange={(v) => set((sc) => (sc.balances[id].pension = v))} />
        <NumField label="GIA" value={b.gia} step={1000} onChange={(v) => set((sc) => (sc.balances[id].gia = v))} />
        <NumField label="Savings" value={b.savings} step={1000} onChange={(v) => set((sc) => (sc.balances[id].savings = v))} />
        <NumField label="Gilts" value={b.gilts} step={1000} onChange={(v) => set((sc) => (sc.balances[id].gilts = v))} />
        <PctField label="GIA embedded gain" value={b.giaGainFraction} onChange={(v) => set((sc) => (sc.balances[id].giaGainFraction = v))} />
      </div>
    );
  };

  return (
    <div>
      <div className="card">
        <h2>Rates</h2>
        <PctField label="Investment growth" value={s.rates.investmentGrowth} onChange={(v) => update((sc) => (sc.rates.investmentGrowth = v))} />
        <PctField label="Savings interest" value={s.rates.savingsInterest} onChange={(v) => update((sc) => (sc.rates.savingsInterest = v))} />
        <PctField label="Inflation" value={s.rates.inflation} onChange={(v) => update((sc) => (sc.rates.inflation = v))} />
        <PctField label="Gilt coupon" value={s.rates.giltCoupon} onChange={(v) => update((sc) => (sc.rates.giltCoupon = v))} />
        <PctField label="GIA dividend yield" value={s.rates.giaDividendYield} onChange={(v) => update((sc) => (sc.rates.giaDividendYield = v))} />
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
        <NumField label="Start year" value={s.income.startYear} onChange={(v) => update((sc) => (sc.income.startYear = v))} />
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
        <div className="field">
          <label>Model start date</label>
          <input
            type="date"
            value={s.startDate}
            onChange={(e) => update((sc) => (sc.startDate = e.target.value))}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Per-person opening balances are set in the Nick / Tracy cards below.
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
            <div className="section-title" style={{ color: id === "nick" ? "var(--nick)" : "var(--tracy)" }}>
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
