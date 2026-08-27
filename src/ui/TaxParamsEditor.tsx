import type { Scenario, TaxYearParams } from "../model/types";
import { resolveTaxParams } from "../tax/taxParams";
import { useStore } from "../store/scenarioStore";

const FIELDS: { key: keyof Omit<TaxYearParams, "year">; label: string; pct?: boolean }[] = [
  { key: "personalAllowance", label: "Personal allowance" },
  { key: "basicRateBand", label: "Basic-rate band" },
  { key: "higherRateBand", label: "Higher-rate band" },
  { key: "basicRate", label: "Basic rate", pct: true },
  { key: "higherRate", label: "Higher rate", pct: true },
  { key: "additionalRate", label: "Additional rate", pct: true },
  { key: "cgtAnnualExempt", label: "CGT allowance" },
  { key: "cgtHigherRate", label: "CGT higher", pct: true },
  { key: "isaAllowance", label: "ISA allowance" },
];

export function TaxParamsEditor({ scenario }: { scenario: Scenario }) {
  const update = useStore((st) => st.update);
  const years: number[] = [];
  for (let i = 0; i < Math.min(scenario.income.years, 60); i++) years.push(scenario.income.startYear + i);

  const policy = scenario.taxPolicy;
  const editedYears = scenario.taxParams.length;

  const setField = (year: number, key: keyof Omit<TaxYearParams, "year">, value: number) => {
    update((sc) => {
      const existing = resolveTaxParams(sc.taxParams, year, sc.taxPolicy);
      const next: TaxYearParams = { ...existing, year, [key]: value };
      const idx = sc.taxParams.findIndex((t) => t.year === year);
      if (idx >= 0) sc.taxParams[idx] = next;
      else sc.taxParams.push(next);
    });
  };

  const resetYear = (year: number) =>
    update((sc) => {
      sc.taxParams = sc.taxParams.filter((t) => t.year !== year);
    });

  const resetAll = () =>
    update((sc) => {
      sc.taxParams = [];
    });

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
          Freeze allowances until
          <input
            type="number"
            style={{ width: 84 }}
            step={1}
            value={policy.freezeUntilYear}
            onChange={(e) =>
              update((sc) => (sc.taxPolicy.freezeUntilYear = Math.round(parseFloat(e.target.value) || 0)))
            }
          />
          <span>/{(policy.freezeUntilYear + 1).toString().slice(-2)}</span>
        </label>
        <label className="muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          Uprating after freeze
          <input
            type="number"
            style={{ width: 84 }}
            step={0.1}
            value={Math.round(policy.uprating * 10000) / 100}
            onChange={(e) => update((sc) => (sc.taxPolicy.uprating = (parseFloat(e.target.value) || 0) / 100))}
          />
          <span>%</span>
        </label>
      </div>

      <div className="warn-banner">
        Defaults are best-known England &amp; Wales figures, held flat in cash terms — the personal
        allowance, the bands and the ISA and CGT allowances are frozen by policy until at least 2031,
        so nothing above rises unless you set an uprating. These are a planning aid, not tax advice —
        verify against HMRC. Edit any cell to override a year.
      </div>
      <div style={{ overflow: "auto", maxHeight: "70vh" }}>
        <table>
          <thead>
            <tr>
              <th className="label">Year</th>
              {FIELDS.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const p = resolveTaxParams(scenario.taxParams, year, policy);
              const edited = scenario.taxParams.some((t) => t.year === year);
              return (
                <tr key={year} className={edited ? "balance" : ""}>
                  <td className="label">
                    {year}/{year + 1} {edited ? <span className="pill">edited</span> : null}
                  </td>
                  {FIELDS.map((f) => (
                    <td key={f.key}>
                      <input
                        type="number"
                        style={{ width: 84 }}
                        step={f.pct ? 0.01 : 100}
                        value={f.pct ? Math.round((p[f.key] as number) * 10000) / 100 : (p[f.key] as number)}
                        onChange={(e) => {
                          const raw = parseFloat(e.target.value) || 0;
                          setField(year, f.key, f.pct ? raw / 100 : raw);
                        }}
                      />
                    </td>
                  ))}
                  <td>
                    {edited ? (
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
