import { useState } from "react";
import type { Scenario, TaxPolicy } from "../model/types";
import { resolveTaxParams, type TaxParamFields } from "../tax/taxParams";
import { useStore } from "../store/scenarioStore";
import { money } from "./format";

type Field = { key: keyof TaxParamFields; label: string; pct?: boolean };

/** Every parameter, grouped so the table stays readable; one group is shown at a time. */
const GROUPS: { id: string; label: string; fields: Field[] }[] = [
  {
    id: "income",
    label: "Income tax",
    fields: [
      { key: "personalAllowance", label: "Personal allowance" },
      { key: "paTaperThreshold", label: "PA taper from" },
      { key: "basicRateBand", label: "Basic-rate band" },
      { key: "higherRateBand", label: "Higher-rate band" },
      { key: "basicRate", label: "Basic rate", pct: true },
      { key: "higherRate", label: "Higher rate", pct: true },
      { key: "additionalRate", label: "Additional rate", pct: true },
    ],
  },
  {
    id: "savings",
    label: "Savings",
    fields: [
      { key: "savingsStartingRateBand", label: "Starting-rate band" },
      { key: "psaBasic", label: "PSA (basic)" },
      { key: "psaHigher", label: "PSA (higher)" },
      { key: "savingsBasicRate", label: "Basic rate", pct: true },
      { key: "savingsHigherRate", label: "Higher rate", pct: true },
      { key: "savingsAdditionalRate", label: "Additional rate", pct: true },
    ],
  },
  {
    id: "dividends",
    label: "Dividends",
    fields: [
      { key: "dividendAllowance", label: "Allowance" },
      { key: "dividendBasicRate", label: "Ordinary rate", pct: true },
      { key: "dividendHigherRate", label: "Upper rate", pct: true },
      { key: "dividendAdditionalRate", label: "Additional rate", pct: true },
    ],
  },
  {
    id: "cgt",
    label: "CGT",
    fields: [
      { key: "cgtAnnualExempt", label: "Annual exempt amount" },
      { key: "cgtBasicRate", label: "Basic rate", pct: true },
      { key: "cgtHigherRate", label: "Higher rate", pct: true },
    ],
  },
  { id: "isa", label: "ISA", fields: [{ key: "isaAllowance", label: "ISA allowance" }] },
];

export function TaxParamsEditor({ scenario }: { scenario: Scenario }) {
  const update = useStore((st) => st.update);
  const [groupId, setGroupId] = useState(GROUPS[0].id);
  const group = GROUPS.find((g) => g.id === groupId) ?? GROUPS[0];

  const years: number[] = [];
  for (let i = 0; i < Math.min(scenario.income.years, 60); i++) years.push(scenario.income.startYear + i);

  const policy = scenario.taxPolicy;
  const inflation = scenario.rates.inflation;
  const editedYears = scenario.taxParams.length;

  // Store only the field the user changed; the rest of the year keeps following the projection.
  const setField = (year: number, key: keyof TaxParamFields, value: number) =>
    update((sc) => {
      let row = sc.taxParams.find((t) => t.year === year);
      if (!row) {
        row = { year };
        sc.taxParams.push(row);
      }
      row[key] = value;
    });

  const resetYear = (year: number) =>
    update((sc) => {
      sc.taxParams = sc.taxParams.filter((t) => t.year !== year);
    });

  const resetAll = () =>
    update((sc) => {
      sc.taxParams = [];
    });

  const setPolicy = (patch: Partial<TaxPolicy>) => update((sc) => Object.assign(sc.taxPolicy, patch));

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Tax parameters (editable per year)</h2>
        <button className="ghost" disabled={editedYears === 0} onClick={resetAll}>
          Reset all to defaults{editedYears > 0 ? ` (${editedYears})` : ""}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", margin: "10px 0" }}>
        <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          Thresholds frozen until
          <input
            type="number"
            style={{ width: 84 }}
            step={1}
            value={policy.freezeUntilYear}
            onChange={(e) => setPolicy({ freezeUntilYear: Math.round(parseFloat(e.target.value) || 0) })}
          />
          <span>/{(policy.freezeUntilYear + 1).toString().slice(-2)}</span>
        </label>
        <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          After the freeze
          <select
            value={policy.indexation}
            onChange={(e) => setPolicy({ indexation: e.target.value as TaxPolicy["indexation"] })}
          >
            <option value="statutory">Statutory: allowance &amp; basic band rise with inflation</option>
            <option value="custom">Custom uprating of all allowances</option>
          </select>
        </label>
        {policy.indexation === "custom" ? (
          <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            Uprating
            <input
              type="number"
              style={{ width: 84 }}
              step={0.1}
              value={Math.round(policy.uprating * 10000) / 100}
              onChange={(e) => setPolicy({ uprating: (parseFloat(e.target.value) || 0) / 100 })}
            />
            <span>% a year</span>
          </label>
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>
            using your {Math.round(inflation * 1000) / 10}% inflation assumption
          </span>
        )}
      </div>

      <div className="warn-banner">
        Defaults are best-known England &amp; Wales figures: 2025/26 rates, the announced dividend rates
        from 2026/27 (10.75% / 35.75%) and savings-income rates from 2027/28 (24% / 44% / 49%, from the
        Autumn Budget 2026 — still to be legislated). Thresholds are frozen until 2030/31; after that, by
        default, the personal allowance and basic-rate band rise with inflation (the statutory default),
        while the {money(125140)} additional-rate threshold, the {money(100000)} allowance taper and the
        other allowances stay fixed — so over long horizons the bands can overtake those fixed thresholds,
        as the law literally implies. Pensions entering the inheritance-tax estate from April 2027 are not
        modelled. A planning aid, not tax advice — verify against HMRC. Edit any cell to override that
        year; edited cells are outlined.
      </div>

      <div className="tabs" style={{ margin: "8px 0" }}>
        {GROUPS.map((g) => (
          <button key={g.id} className={g.id === group.id ? "active" : ""} onClick={() => setGroupId(g.id)}>
            {g.label}
          </button>
        ))}
      </div>

      <div style={{ overflow: "auto", maxHeight: "70vh" }}>
        <table>
          <thead>
            <tr>
              <th className="label">Year</th>
              {group.fields.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              {group.id === "income" ? <th>45% from (taxable)</th> : null}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const p = resolveTaxParams(scenario.taxParams, year, policy, inflation);
              const row = scenario.taxParams.find((t) => t.year === year);
              return (
                <tr key={year} className={row ? "balance" : ""}>
                  <td className="label">
                    {year}/{year + 1} {row ? <span className="pill">edited</span> : null}
                  </td>
                  {group.fields.map((f) => {
                    const edited = row?.[f.key] != null;
                    const v = p[f.key];
                    return (
                      <td key={f.key}>
                        <input
                          type="number"
                          style={{ width: 84, outline: edited ? "1px solid var(--warn)" : undefined }}
                          title={edited ? "Edited for this year" : "Projected default"}
                          step={f.pct ? 0.01 : 100}
                          value={f.pct ? Math.round(v * 10000) / 100 : v}
                          onChange={(e) => {
                            const raw = parseFloat(e.target.value) || 0;
                            setField(year, f.key, f.pct ? raw / 100 : raw);
                          }}
                        />
                      </td>
                    );
                  })}
                  {group.id === "income" ? <td>{money(p.basicRateBand + p.higherRateBand)}</td> : null}
                  <td>
                    {row ? (
                      <button className="ghost" title={`Reset ${year}/${year + 1}`} onClick={() => resetYear(year)}>
                        Reset
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
