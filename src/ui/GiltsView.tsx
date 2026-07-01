import type { SimResult } from "../engine/simulate";
import { money, shortDate } from "./format";
import { useRowSelection } from "./useRowSelection";

export function GiltsView({ result }: { result: SimResult }) {
  const { toggle, rowClass } = useRowSelection();
  const gilts = [...result.gilts].sort(
    (a, b) =>
      a.purchaseDateIso.localeCompare(b.purchaseDateIso) ||
      a.maturityDateIso.localeCompare(b.maturityDateIso),
  );
  const total = gilts.reduce((s, g) => s + g.nominal, 0);
  const purchased = gilts.filter((g) => !g.initial).reduce((s, g) => s + g.nominal, 0);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>Gilt ladder — purchases &amp; maturities</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {gilts.length} rungs · {money(total)} nominal ({money(purchased)} bought by the strategy)
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Each rung is bought at the end of a tax year to hold part of the cash buffer as gilts, and
        redeems at par on its maturity date (feeding cash back into the buffer). Gilt capital gains are
        CGT-exempt; only the coupon is taxable.
      </p>
      <div style={{ overflow: "auto", maxHeight: "68vh" }}>
        <table className="sticky-first">
          <thead>
            <tr>
              <th className="label">Purchase date</th>
              <th className="label">Holder</th>
              <th className="label">Rung</th>
              <th>Nominal</th>
              <th>Coupon</th>
              <th className="label">Target maturity date</th>
              <th className="label">Source</th>
            </tr>
          </thead>
          <tbody>
            {gilts.map((g, i) => (
              <tr key={i} className={rowClass(i)} onClick={() => toggle(i)}>
                <td className="label">{shortDate(g.purchaseDateIso)}</td>
                <td className="label" style={{ color: g.holder === "nick" ? "var(--nick)" : "var(--tracy)" }}>
                  {g.holder === "nick" ? "Nick" : "Tracy"}
                </td>
                <td className="label">{g.name}</td>
                <td>{money(g.nominal)}</td>
                <td>{(g.couponRate * 100).toFixed(2)}%</td>
                <td className="label">{shortDate(g.maturityDateIso)}</td>
                <td className="label">
                  <span className="pill">{g.initial ? "held at start" : "ladder purchase"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
