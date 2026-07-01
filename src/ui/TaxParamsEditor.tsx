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

  const setField = (year: number, key: keyof Omit<TaxYearParams, "year">, value: number) => {
    update((sc) => {
      const existing = resolveTaxParams(sc.taxParams, year, sc.rates.inflation);
      const next: TaxYearParams = { ...existing, year, [key]: value };
      const idx = sc.taxParams.findIndex((t) => t.year === year);
      if (idx >= 0) sc.taxParams[idx] = next;
      else sc.taxParams.push(next);
    });
  };

  return (
    <div className="card">
      <h2>Tax parameters (editable per year)</h2>
      <div className="warn-banner">
        Defaults are best-known England &amp; Wales figures, frozen to 2028 then uprated with inflation.
        These are a planning aid, not tax advice — verify against HMRC. Edit any cell to override a year.
      </div>
      <div style={{ overflow: "auto", maxHeight: "70vh" }}>
        <table>
          <thead>
            <tr>
              <th className="label">Year</th>
              {FIELDS.map((f) => (
                <th key={f.key}>{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const p = resolveTaxParams(scenario.taxParams, year, scenario.rates.inflation);
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
