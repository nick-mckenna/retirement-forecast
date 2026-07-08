import type { Scenario } from "../model/types";
import type { SimResult, YearSummary } from "../engine/simulate";
import { money } from "./format";
import { useRowSelection } from "./useRowSelection";

function rowTotalSold(y: YearSummary): number {
  const s = y.disposals.sales;
  return (
    s.nick.pension + s.nick.gia + s.nick.isa + s.tracy.pension + s.tracy.gia + s.tracy.isa +
    y.disposals.giltMaturities.nick + y.disposals.giltMaturities.tracy
  );
}

export function DisposalsView({ result, scenario }: { result: SimResult; scenario: Scenario }) {
  const years = result.years;
  const { toggle, rowClass } = useRowSelection();
  const totals = years.reduce(
    (acc, y) => {
      const s = y.disposals.sales;
      acc.pension += s.nick.pension + s.tracy.pension;
      acc.gia += s.nick.gia + s.tracy.gia;
      acc.isa += s.nick.isa + s.tracy.isa;
      acc.bedIsa += y.disposals.isaFill.nick + y.disposals.isaFill.tracy;
      acc.gilts += y.disposals.giltMaturities.nick + y.disposals.giltMaturities.tracy;
      acc.gain += y.disposals.realisedGain.nick + y.disposals.realisedGain.tracy;
      return acc;
    },
    { pension: 0, gia: 0, isa: 0, bedIsa: 0, gilts: 0, gain: 0 },
  );

  const cell = (v: number) => (v > 0.5 ? money(v) : <span className="muted">—</span>);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>Asset disposals by year</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          mode: {scenario.strategy.taxMode}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Investments sold each tax year to fund income and refill the buffer. "Bed &amp; ISA" moves GIA
        into the ISA wrapper (a CGT disposal); "Gilts matured" redeem at par (CGT-exempt). Over the
        whole plan: pension {money(totals.pension)}, GIA {money(totals.gia)}, ISA {money(totals.isa)},
        Bed &amp; ISA {money(totals.bedIsa)}, gilts redeemed {money(totals.gilts)}, gains realised{" "}
        {money(totals.gain)}.
      </p>
      <div style={{ overflow: "auto", maxHeight: "72vh" }}>
        <table>
          <thead>
            <tr>
              <th className="label" rowSpan={2}>
                Tax year
              </th>
              <th colSpan={3} style={{ color: "var(--nick)" }}>
                {scenario.people.nick.name} sold
              </th>
              <th colSpan={3} style={{ color: "var(--tracy)" }}>
                {scenario.people.tracy.name} sold
              </th>
              <th rowSpan={2}>Bed &amp; ISA</th>
              <th rowSpan={2}>Gilts matured</th>
              <th rowSpan={2}>Gain realised</th>
              <th rowSpan={2}>Total sold</th>
            </tr>
            <tr>
              <th>Pension</th>
              <th>GIA</th>
              <th>ISA</th>
              <th>Pension</th>
              <th>GIA</th>
              <th>ISA</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const d = y.disposals;
              const total = rowTotalSold(y);
              if (total < 0.5 && d.isaFill.nick + d.isaFill.tracy < 0.5) {
                return (
                  <tr key={y.taxYearStart} className={rowClass(y.taxYearStart)} onClick={() => toggle(y.taxYearStart)}>
                    <td className="label">
                      {y.taxYearStart}/{y.taxYearStart + 1}
                    </td>
                    <td colSpan={10} className="muted">
                      no disposals
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={y.taxYearStart} className={rowClass(y.taxYearStart)} onClick={() => toggle(y.taxYearStart)}>
                  <td className="label">
                    {y.taxYearStart}/{y.taxYearStart + 1}
                  </td>
                  <td>{cell(d.sales.nick.pension)}</td>
                  <td>{cell(d.sales.nick.gia)}</td>
                  <td>{cell(d.sales.nick.isa)}</td>
                  <td>{cell(d.sales.tracy.pension)}</td>
                  <td>{cell(d.sales.tracy.gia)}</td>
                  <td>{cell(d.sales.tracy.isa)}</td>
                  <td>{cell(d.isaFill.nick + d.isaFill.tracy)}</td>
                  <td>{cell(d.giltMaturities.nick + d.giltMaturities.tracy)}</td>
                  <td>{cell(d.realisedGain.nick + d.realisedGain.tracy)}</td>
                  <td>{cell(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
