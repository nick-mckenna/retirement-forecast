import { useMemo, useState } from "react";
import type { SimResult } from "../engine/simulate";
import type { Scenario } from "../model/types";
import type { GiltMarket } from "../gilts/types";
import { buildPricing, netYield, yieldFromClean } from "../gilts/pricing";
import { accruedPer100, fundsYear } from "../gilts/schedule";
import { GiltMarketStatus } from "./GiltMarketStatus";
import { money, shortDate } from "./format";
import { useRowSelection } from "./useRowSelection";

const pct2 = (x: number | undefined) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);

export function GiltsView({ result, scenario, market }: { result: SimResult; scenario: Scenario; market: GiltMarket | null }) {
  const { toggle, rowClass } = useRowSelection();
  const [showMarket, setShowMarket] = useState(false);
  const gilts = [...result.gilts].sort(
    (a, b) =>
      a.purchaseDateIso.localeCompare(b.purchaseDateIso) ||
      a.maturityDateIso.localeCompare(b.maturityDateIso),
  );
  const total = gilts.reduce((s, g) => s + g.nominal, 0);
  const purchased = gilts.filter((g) => !g.initial).reduce((s, g) => s + g.nominal, 0);
  const realBought = gilts.filter((g) => !g.initial && g.isin).length;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2>Gilt ladder — purchases &amp; maturities</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {gilts.length} rungs · {money(total)} nominal ({money(purchased)} bought by the strategy
            {realBought > 0 ? `, ${realBought} real` : ""})
          </span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Each rung is bought at the end of a tax year to hold part of the cash buffer as gilts, and
          redeems at par on its maturity date (feeding cash back into the buffer). Gilt capital gains are
          CGT-exempt; only the coupon is taxable. Real gilts (with an ISIN) pay their real half-yearly
          coupons, redeem on their real dates and are valued at DMO prices, modelled forward from today's;
          those bought by the ladder show the clean price paid and their yield before and after tax at the
          holder's marginal rate on savings income when bought.
        </p>
        <div style={{ overflow: "auto", maxHeight: "60vh" }}>
          <table className="sticky-first">
            <thead>
              <tr>
                <th className="label">Purchase date</th>
                <th className="label">Holder</th>
                <th className="label">Gilt</th>
                <th className="label">ISIN</th>
                <th>Nominal</th>
                <th>Coupon</th>
                <th title="Clean price paid per £100 nominal">Price</th>
                <th title="Cash paid (clean price plus accrued interest)">Cost</th>
                <th title="Gross redemption yield when bought">Yield</th>
                <th title="Yield after tax on the coupons at the holder's marginal savings rate when bought">After tax</th>
                <th className="label">Maturity date</th>
                <th className="label">Source</th>
              </tr>
            </thead>
            <tbody>
              {gilts.map((g, i) => (
                <tr key={i} className={rowClass(i)} onClick={() => toggle(i)}>
                  <td className="label">{shortDate(g.purchaseDateIso)}</td>
                  <td className="label" style={{ color: g.holder === "nick" ? "var(--nick-text)" : "var(--tracy-text)" }}>
                    {scenario.people[g.holder].name}
                  </td>
                  <td className="label">{g.name}</td>
                  <td className="label muted">{g.isin ?? "—"}</td>
                  <td>{money(g.nominal)}</td>
                  <td>{(g.couponRate * 100).toFixed(2)}%</td>
                  <td>{g.cleanPrice != null ? g.cleanPrice.toFixed(2) : "—"}</td>
                  <td>{g.cost != null ? money(g.cost) : "—"}</td>
                  <td>{pct2(g.grossYield)}</td>
                  <td title={g.taxRate != null ? `at ${Math.round(g.taxRate * 100)}% tax` : undefined}>
                    {pct2(g.netYield)}
                    {g.taxRate != null && <span className="muted"> ({Math.round(g.taxRate * 100)}%)</span>}
                  </td>
                  <td className="label">{shortDate(g.maturityDateIso)}</td>
                  <td className="label">
                    <span className="pill">
                      {g.initial ? (g.isin ? "held at start (real)" : "held at start") : g.isin ? "ladder purchase (real)" : "ladder purchase"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2>Gilt market</h2>
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
            <GiltMarketStatus />
            <button className="ghost" onClick={() => setShowMarket((v) => !v)}>
              {showMarket ? "Hide" : "Show"}
            </button>
          </span>
        </div>
        {showMarket && <MarketTable market={market} />}
      </div>
    </>
  );
}

/** Today's conventional gilts from the DMO: price, yield before tax and after tax at 20% and 40%,
 *  and the tax year each would fund. */
function MarketTable({ market }: { market: GiltMarket | null }) {
  const rows = useMemo(() => {
    if (!market?.asOf) return [];
    const asOf = market.asOf;
    const pricing = buildPricing(market);
    return market.instruments
      .filter((i) => !i.indexLinked && i.redemptionDate > asOf && pricing.observed(i.isin, asOf, "buy") !== null)
      .sort((a, b) => a.redemptionDate.localeCompare(b.redemptionDate))
      .map((i) => {
        const buy = pricing.observed(i.isin, asOf, "buy")!;
        const sell = pricing.observed(i.isin, asOf, "sell")!;
        const dirty = buy + accruedPer100(i, asOf);
        return {
          i,
          buy,
          sell,
          gross: yieldFromClean(i, asOf, buy),
          net20: netYield(i, asOf, dirty, 0.2),
          net40: netYield(i, asOf, dirty, 0.4),
          funds: fundsYear(i.redemptionDate),
        };
      });
  }, [market]);
  if (rows.length === 0) return <p className="muted">No DMO prices yet — press Refresh.</p>;
  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Conventional gilts in issue at the DMO's purchase price on {shortDate(market!.asOf!)}. The
        yield after tax counts the coupons net of income tax (the first relieved by the accrued
        interest bought) and the CGT-free redemption — why low-coupon gilts suit taxpayers. "Funds"
        is the tax year whose spending a gilt redeeming then can pay for.
      </p>
      <div style={{ overflow: "auto", maxHeight: "60vh" }}>
        <table className="sticky-first">
          <thead>
            <tr>
              <th className="label">Gilt</th>
              <th className="label">ISIN</th>
              <th className="label">Redeems</th>
              <th className="label">Funds</th>
              <th>Buy</th>
              <th>Sell</th>
              <th>Yield</th>
              <th>After 20% tax</th>
              <th>After 40% tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.i.isin}>
                <td className="label">{r.i.name}</td>
                <td className="label muted">{r.i.isin}</td>
                <td className="label">{shortDate(r.i.redemptionDate)}</td>
                <td className="label">
                  {r.funds}/{String(r.funds + 1).slice(2)}
                </td>
                <td>{r.buy.toFixed(2)}</td>
                <td>{r.sell.toFixed(2)}</td>
                <td>{pct2(r.gross)}</td>
                <td>{pct2(r.net20)}</td>
                <td>{pct2(r.net40)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
