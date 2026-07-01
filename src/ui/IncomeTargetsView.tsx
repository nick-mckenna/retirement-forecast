import type { Scenario } from "../model/types";
import { buildIncomeTargets, investableAssets, resolveIncome } from "../model/incomeTargets";
import { money } from "./format";
import { useRowSelection } from "./useRowSelection";

export function IncomeTargetsView({ scenario }: { scenario: Scenario }) {
  const { toggle, rowClass } = useRowSelection();
  const income = resolveIncome(scenario);
  const targets = buildIncomeTargets(income);
  return (
    <div className="card">
      <h2>Income targets</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        {scenario.income.mode === "swr"
          ? `${(scenario.income.swrRate * 100).toFixed(1)}% of ${money(investableAssets(scenario))} investable assets = `
          : "Base "}
        {money(income.baseAnnual)} in {income.startYear}/{income.startYear + 1}, inflating{" "}
        {(income.growth * 100).toFixed(1)}% per year.
      </p>
      <div style={{ overflowY: "auto", maxHeight: "72vh" }}>
        <table>
          <thead>
            <tr>
              <th className="label">Tax year</th>
              <th>Target annual income</th>
              <th>Target monthly income</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.startYear} className={rowClass(t.startYear)} onClick={() => toggle(t.startYear)}>
                <td className="label">
                  {t.startYear}/{t.endYear}
                </td>
                <td>{money(t.annual)}</td>
                <td>{money(t.monthly)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
