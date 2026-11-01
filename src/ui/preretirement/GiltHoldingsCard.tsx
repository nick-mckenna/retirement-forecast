import { useMemo } from "react";
import type { Scenario } from "../../model/types";
import type { GiltPayout, InvestmentAccount } from "../../model/preRetirementTypes";
import type { GiltInstrument, GiltLot } from "../../gilts/types";
import { usePreRetirementStore } from "../../store/preRetirementStore";
import { ukToday, useGiltMarketStore } from "../../store/giltMarketStore";
import { buildPricing } from "../../gilts/pricing";
import { isIsoDate } from "../../tax/taxYear";
import { isHeld } from "../../preretirement/giltAccounts";
import { GiltMarketStatus } from "../GiltMarketStatus";
import { money, shortDate } from "../format";

function parseAmount(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function couponLabel(rate: number): string {
  return `${Math.round(rate * 100000) / 1000}%`;
}

/** The real gilts held in each gilts account: one row per purchase, picked from the DMO's list
 *  of gilts in issue, valued at DMO prices. */
export function GiltHoldingsCard({ scenario }: { scenario: Scenario }) {
  const data = usePreRetirementStore((st) => st.data);
  const update = usePreRetirementStore((st) => st.update);
  const market = useGiltMarketStore((st) => st.market);
  const pricing = useMemo(() => buildPricing(market), [market]);
  const today = ukToday();

  const giltAccounts = data.accounts.filter((a) => a.kind === "gilts");
  // Conventional gilts still in issue, nearest redemption first; index-linked listed but disabled.
  const instruments = useMemo(
    () =>
      [...(market?.instruments ?? [])]
        .filter((i) => i.redemptionDate > today)
        .sort((a, b) => Number(a.indexLinked) - Number(b.indexLinked) || a.redemptionDate.localeCompare(b.redemptionDate)),
    [market, today],
  );
  const firstPickable = instruments.find((i) => !i.indexLinked && !i.rump);

  if (giltAccounts.length === 0) return null;

  const editLot = (id: string, mut: (l: GiltLot) => void) =>
    update((d) => {
      const l = d.giltLots.find((x) => x.id === id);
      if (l) mut(l);
    });

  const pick = (lot: GiltLot, inst: GiltInstrument) => {
    lot.isin = inst.isin;
    lot.name = inst.name;
    lot.couponRate = inst.couponRate;
    lot.redemptionDate = inst.redemptionDate;
    if (lot.purchaseDate >= inst.redemptionDate) lot.purchaseDate = today;
  };

  const addLot = (account: InvestmentAccount) => {
    if (!firstPickable) return;
    update((d) => {
      const lot: GiltLot = {
        id: `lot-${Date.now()}`,
        accountId: account.id,
        isin: "",
        name: "",
        couponRate: 0,
        redemptionDate: "",
        nominal: 1000,
        purchaseDate: today,
        purchaseCleanPrice: null,
      };
      pick(lot, firstPickable);
      d.giltLots.push(lot);
    });
  };

  const deleteLot = (id: string) => update((d) => (d.giltLots = d.giltLots.filter((l) => l.id !== id)));

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2>Gilt holdings</h2>
        <GiltMarketStatus />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Record the real gilts each gilts account holds — one row per purchase, picked from the DMO's
        list of gilts in issue. An account with holdings is valued as its <b>cash</b> (its opening
        balance is then the cash only, plus money tagged in) and the gilts at DMO sale prices plus
        accrued interest — modelled forward from today's prices. Coupons (half the annual rate, on the
        redemption day every six months) and the redemption arrive on their real dates. A purchase
        costs the clean price you enter (blank = the DMO buy price that day) plus accrued interest.
        At retirement the gilts are handed to the forecast as themselves. Only conventional gilts can
        be held; index-linked ones are listed but not modelled.
      </p>
      {!market?.asOf && (
        <p style={{ fontSize: 13, color: "#f0883e" }}>
          No DMO data yet — press Refresh (the local server fetches it from dmo.gov.uk).
        </p>
      )}
      {giltAccounts.map((a) => {
        const lots = data.giltLots.filter((l) => l.accountId === a.id);
        const heldValue = lots
          .filter((l) => isHeld(l, today))
          .reduce((s, l) => s + (l.nominal * pricing.dirty(l.isin, l, today, "sell")) / 100, 0);
        return (
          <div key={a.id} style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <b>{a.name}</b>
              <span className="muted" style={{ fontSize: 12 }}>
                {scenario.people[a.owner].name}
              </span>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
                Coupons &amp; redemptions
                <select
                  value={a.giltPayout}
                  onChange={(ev) =>
                    update((d) => {
                      const acc = d.accounts.find((x) => x.id === a.id);
                      if (acc) acc.giltPayout = ev.target.value as GiltPayout;
                    })
                  }
                >
                  <option value="account">stay in the account as cash</option>
                  <option value="external">are paid out (e.g. to the joint account)</option>
                </select>
              </label>
              <span style={{ flex: 1 }} />
              {lots.length > 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Gilts held today: {money(heldValue)}
                </span>
              )}
              <button className="ghost" disabled={!firstPickable} onClick={() => addLot(a)}>
                + Add holding
              </button>
            </div>
            {a.giltPayout === "external" && lots.length > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>
                Paid-out coupons and redemptions leave this account; add them as income lines in the
                expense tracker if they land in the joint account.
              </p>
            )}
            {lots.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table className="fit zebra">
                  <thead>
                    <tr>
                      <th className="label">Gilt</th>
                      <th>Coupon</th>
                      <th>Matures</th>
                      <th>Nominal</th>
                      <th>Bought (settled)</th>
                      <th title="Clean price paid per £100 nominal; blank = the DMO buy price that day">Clean price paid</th>
                      <th>Value today</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lots.map((l) => {
                      const known = instruments.some((i) => i.isin === l.isin);
                      const dmoBuy = isIsoDate(l.purchaseDate) ? pricing.observed(l.isin, l.purchaseDate, "buy") : null;
                      const value = isHeld(l, today) ? (l.nominal * pricing.dirty(l.isin, l, today, "sell")) / 100 : null;
                      return (
                        <tr key={l.id}>
                          <td className="label">
                            <select
                              style={{ maxWidth: 320 }}
                              value={l.isin}
                              onChange={(ev) => {
                                const inst = instruments.find((i) => i.isin === ev.target.value);
                                if (inst) editLot(l.id, (x) => pick(x, inst));
                              }}
                            >
                              {!known && (
                                <option value={l.isin}>
                                  {l.name} ({l.isin})
                                </option>
                              )}
                              {instruments.map((i) => (
                                <option key={i.isin} value={i.isin} disabled={i.indexLinked || i.rump}>
                                  {i.name} — {shortDate(i.redemptionDate)}
                                  {i.indexLinked ? " (index-linked: not modelled)" : i.rump ? " (rump)" : ""}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>{couponLabel(l.couponRate)}</td>
                          <td>{shortDate(l.redemptionDate)}</td>
                          <td>
                            <input
                              type="number"
                              step={100}
                              min={0}
                              style={{ width: 100 }}
                              value={l.nominal}
                              onChange={(ev) => editLot(l.id, (x) => (x.nominal = Math.max(0.01, parseAmount(ev.target.value))))}
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={l.purchaseDate}
                              max={l.redemptionDate}
                              onChange={(ev) => {
                                const v = ev.target.value;
                                if (isIsoDate(v) && v < l.redemptionDate) editLot(l.id, (x) => (x.purchaseDate = v));
                              }}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step={0.01}
                              min={0}
                              style={{ width: 90 }}
                              placeholder={dmoBuy != null ? dmoBuy.toFixed(2) : "DMO"}
                              value={l.purchaseCleanPrice ?? ""}
                              onChange={(ev) =>
                                editLot(l.id, (x) => {
                                  const n = parseAmount(ev.target.value);
                                  x.purchaseCleanPrice = ev.target.value === "" || n <= 0 ? null : n;
                                })
                              }
                            />
                          </td>
                          <td>{value == null ? <span className="muted">{l.redemptionDate <= today ? "redeemed" : "not yet bought"}</span> : money(value)}</td>
                          <td>
                            <button className="ghost" onClick={() => deleteLot(l.id)}>
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
