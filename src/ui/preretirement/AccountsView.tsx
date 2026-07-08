import type { PersonId, Scenario } from "../../model/types";
import type { PreAccountKind } from "../../model/preRetirementTypes";
import { PRE_ACCOUNT_KINDS, PRE_ACCOUNT_KIND_LABELS } from "../../model/preRetirementTypes";
import { usePreRetirementStore } from "../../store/preRetirementStore";
import type { BalanceOverride } from "../../model/preRetirementTypes";
import { daysInMonth, isMonthKey, monthKeyOf } from "../../expenses/calc";
import { pct } from "../format";

function parseAmount(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** "yyyy-mm-dd" for the date input; a null day (legacy end-of-month record)
 *  shows as the month's last day, which means the same thing. */
function overrideDateIso(o: BalanceOverride): string {
  const dim = daysInMonth(o.monthKey);
  return `${o.monthKey}-${String(Math.min(o.day ?? dim, dim)).padStart(2, "0")}`;
}

/** The account registry (real, named accounts), opening balances and
 *  actual-balance overrides — the editable inputs of the projection. */
export function AccountsView({ scenario }: { scenario: Scenario }) {
  const data = usePreRetirementStore((st) => st.data);
  const update = usePreRetirementStore((st) => st.update);

  const editAccount = (id: string, mut: (a: (typeof data.accounts)[number]) => void) =>
    update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) mut(a);
    });

  const addAccount = () =>
    update((d) => {
      d.accounts.push({
        id: `acc-${Date.now()}`,
        name: "New account",
        owner: "nick",
        kind: "savings",
        openingBalance: 0,
        openingGainFraction: null,
      });
    });

  const deleteAccount = (id: string) => {
    const acc = data.accounts.find((a) => a.id === id);
    if (!acc) return;
    if (
      !confirm(
        `Delete "${acc.name}"?\n\nIts balance overrides are removed too. Expense lines tagged to it ` +
          `keep their tag but show as "(deleted account)" and stop feeding the forecast.`,
      )
    ) {
      return;
    }
    update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== id);
      d.overrides = d.overrides.filter((o) => o.accountId !== id);
    });
  };

  return (
    <>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2>Opening position</h2>
        <div className="field">
          <label>Balances as of the start of</label>
          <input
            type="month"
            value={data.openingMonth}
            onChange={(e) => {
              const v = e.target.value;
              if (isMonthKey(v)) update((d) => (d.openingMonth = v));
            }}
          />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Enter each account's balance as it stood at the start of this month. Money tagged to an
          account in earlier expense months is ignored — it is already inside these balances.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          Growth follows the account's type, using the active scenario's rates: ISA / Pension / GIA
          grow at {pct(scenario.rates.investmentGrowth)}, Savings and Premium Bonds at{" "}
          {pct(scenario.rates.savingsInterest)}, Gilts at {pct(scenario.rates.giltCoupon)}.
        </p>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Accounts</h2>
          <button className="primary" onClick={addAccount}>
            + Add account
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Your real accounts. The <b>Type</b> groups an account for growth and for the retirement
          handoff (Savings and Premium Bonds both count as retirement savings; the GIA gain % seeds
          the cost basis for CGT).
        </p>
        <table className="fit zebra">
          <thead>
            <tr>
              <th className="label">Account</th>
              <th>Owner</th>
              <th>Type</th>
              <th>Opening balance</th>
              <th>GIA gain %</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <tr key={a.id}>
                <td className="label">
                  <input
                    type="text"
                    style={{ width: 280 }}
                    value={a.name}
                    onChange={(ev) => editAccount(a.id, (x) => (x.name = ev.target.value))}
                  />
                </td>
                <td>
                  <select
                    value={a.owner}
                    onChange={(ev) => editAccount(a.id, (x) => (x.owner = ev.target.value as PersonId))}
                  >
                    <option value="nick">{scenario.people.nick.name}</option>
                    <option value="tracy">{scenario.people.tracy.name}</option>
                  </select>
                </td>
                <td>
                  <select
                    value={a.kind}
                    onChange={(ev) =>
                      editAccount(a.id, (x) => {
                        x.kind = ev.target.value as PreAccountKind;
                        x.openingGainFraction = x.kind === "gia" ? (x.openingGainFraction ?? 0) : null;
                      })
                    }
                  >
                    {PRE_ACCOUNT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {PRE_ACCOUNT_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    step={1000}
                    value={a.openingBalance}
                    onChange={(ev) => editAccount(a.id, (x) => (x.openingBalance = parseAmount(ev.target.value)))}
                  />
                </td>
                <td>
                  {a.kind === "gia" ? (
                    <input
                      type="number"
                      step={1}
                      style={{ width: 70 }}
                      value={Math.round((a.openingGainFraction ?? 0) * 10000) / 100}
                      onChange={(ev) =>
                        editAccount(
                          a.id,
                          (x) => (x.openingGainFraction = Math.min(1, Math.max(0, parseAmount(ev.target.value) / 100))),
                        )
                      }
                    />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <button className="ghost" onClick={() => deleteAccount(a.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ maxWidth: 820 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Actual balances (overrides)</h2>
          <button
            className="primary"
            disabled={data.accounts.length === 0}
            onClick={() =>
              update((d) => {
                const now = new Date();
                d.overrides.push({
                  accountId: d.accounts[0].id,
                  monthKey: monthKeyOf(now),
                  day: now.getDate(),
                  value: 0,
                });
              })
            }
          >
            + Record actual balance
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Record what an account was <b>actually</b> worth at the end of any day (statements,
          valuations, prize winnings, losses). The forecast re-anchors there: the rest of that
          month's growth is pro-rated by calendar days, and contributions due later in the month
          are still added — payments due on or before the recorded day, undated lines and tagged
          income are assumed to be inside the recorded balance. Recording again later in the month
          simply supersedes the earlier entry. This — not the Paid column in the expense tracker —
          is how real growth is fed in.
        </p>
        {data.overrides.length > 0 && (
          <table className="fit zebra">
            <thead>
              <tr>
                <th className="label">Account</th>
                <th>At the end of</th>
                <th>Actual balance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.overrides.map((o, i) => (
                <tr key={`${o.accountId}:${o.monthKey}:${o.day ?? "eom"}:${i}`}>
                  <td className="label">
                    <select
                      value={o.accountId}
                      onChange={(ev) => update((d) => (d.overrides[i].accountId = ev.target.value))}
                    >
                      {data.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                      {!data.accounts.some((a) => a.id === o.accountId) && (
                        <option value={o.accountId}>(deleted account: {o.accountId})</option>
                      )}
                    </select>
                  </td>
                  <td>
                    <input
                      type="date"
                      value={overrideDateIso(o)}
                      onChange={(ev) => {
                        const v = ev.target.value;
                        if (isMonthKey(v.slice(0, 7)) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
                          update((d) => {
                            d.overrides[i].monthKey = v.slice(0, 7);
                            d.overrides[i].day = Number(v.slice(8));
                          });
                        }
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step={0.01}
                      value={o.value}
                      onChange={(ev) => update((d) => (d.overrides[i].value = parseAmount(ev.target.value)))}
                    />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() => update((d) => (d.overrides = d.overrides.filter((_, j) => j !== i)))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
