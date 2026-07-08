import type { SimResult } from "../engine/simulate";
import type { Scenario } from "../model/types";
import { money } from "./format";
import { useRowSelection } from "./useRowSelection";

export function TaxView({ result, scenario }: { result: SimResult; scenario: Scenario }) {
  const { toggle, rowClass } = useRowSelection();
  const nick = scenario.people.nick.name;
  const tracy = scenario.people.tracy.name;
  return (
    <div className="card">
      <h2>Tax &amp; strategy by year</h2>
      <div style={{ overflowX: "auto", maxHeight: "78vh", overflowY: "auto" }}>
        <table className="sticky-first">
          <thead>
            <tr>
              <th className="label">Tax year</th>
              <th>{nick} age</th>
              <th>{tracy} age</th>
              <th>Income target</th>
              <th>Buffer target</th>
              <th>Buffer end</th>
              <th>{nick} taxable inc</th>
              <th>{nick} income tax</th>
              <th>{nick} CGT</th>
              <th>{tracy} taxable inc</th>
              <th>{tracy} income tax</th>
              <th>{tracy} CGT</th>
              <th>Total tax</th>
              <th>Net worth</th>
            </tr>
          </thead>
          <tbody>
            {result.years.map((y) => {
              const total = y.tax.nick.total + y.tax.tracy.total;
              const bufferLow = y.bufferEnd < y.bufferTargetValue * 0.6;
              return (
                <tr key={y.taxYearStart} className={rowClass(y.taxYearStart)} onClick={() => toggle(y.taxYearStart)}>
                  <td className="label">
                    {y.taxYearStart}/{y.taxYearStart + 1}
                  </td>
                  <td>{y.nickAge}</td>
                  <td>{y.tracyAge}</td>
                  <td>{money(y.incomeTarget)}</td>
                  <td>{money(y.bufferTargetValue)}</td>
                  <td className={bufferLow ? "num-neg" : ""}>{money(y.bufferEnd)}</td>
                  <td>{money(y.tax.nick.taxableNonSavings + y.tax.nick.savingsIncome + y.tax.nick.dividends)}</td>
                  <td>{money(y.tax.nick.incomeTax)}</td>
                  <td>{money(y.tax.nick.cgt)}</td>
                  <td>{money(y.tax.tracy.taxableNonSavings + y.tax.tracy.savingsIncome + y.tax.tracy.dividends)}</td>
                  <td>{money(y.tax.tracy.incomeTax)}</td>
                  <td>{money(y.tax.tracy.cgt)}</td>
                  <td>{money(total)}</td>
                  <td>{money(y.netWorthEnd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
