import type { PersonId, Scenario } from "../../model/types";
import type { PreAccountKind } from "../../model/preRetirementTypes";
import { PRE_ACCOUNT_KINDS, PRE_ACCOUNT_KIND_LABELS } from "../../model/preRetirementTypes";
import { usePreRetirementStore } from "../../store/preRetirementStore";
import type { BalanceOverride } from "../../model/preRetirementTypes";
import { latestOverride, overrideDateIso } from "../../preretirement/project";
import { isMonthKey, monthKeyOf } from "../../expenses/calc";
import { pct } from "../format";

function parseAmount(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** The account registry (real, named accounts), opening balances and each
 *  account's latest actual balance — the editable inputs of the projection. */
export function AccountsView({ scenario }: { scenario: Scenario }) {
  const data = usePreRetirementStore((st) => st.data);
  const update = usePreRetirementStore((st) => st.update);
  const setOverride = usePreRetirementStore((st) => st.setOverride);

  const editAccount = (id: string, mut: (a: (typeof data.accounts)[number]) => void) =>
    update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) mut(a);
    });

  /** Typing a balance means "this is what it is worth as of today": upsert
   *  today's record, leaving earlier ones in place so past months stay
   *  anchored to what was recorded at the time. */
  const recordActual = (accountId: string, value: number) => {
    const now = new Date();
    setOverride(accountId, monthKeyOf(now), now.getDate(), value);
  };

  /** Editing the date moves the shown (latest) record to that day, replacing
   *  any record already sitting there. */
  const moveActual = (accountId: string, from: BalanceOverride, dateIso: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !isMonthKey(dateIso.slice(0, 7))) return;
    const monthKey = dateIso.slice(0, 7);
    const day = Number(dateIso.slice(8));
    update((d) => {
      d.overrides = d.overrides.filter(
        (o) =>
          o.accountId !== accountId ||
          !(
            (o.monthKey === from.monthKey && (o.day ?? null) === (from.day ?? null)) ||
            (o.monthKey === monthKey && (o.day ?? null) === day)
          ),
      );
      d.overrides.push({ accountId, monthKey, day, value: from.value, basis: from.basis ?? null });
    });
  };

  const clearActual = (accountId: string, from: BalanceOverride) =>
    setOverride(accountId, from.monthKey, from.day ?? null, null);

  /** The cost basis recorded with the shown (latest) record — GIA accounts only. */
  const setBasis = (accountId: string, from: BalanceOverride, basis: number | null) =>
    update((d) => {
      const o = d.overrides.find(
        (x) => x.accountId === accountId && x.monthKey === from.monthKey && (x.day ?? null) === (from.day ?? null),
      );
      if (o) o.basis = basis == null ? null : Math.max(0, basis);
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
        reliefAtSource: false,
        externalMonthlyContribution: 0,
        maturityYear: null,
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
          grow at {pct(scenario.rates.investmentGrowth)}, Savings at {pct(scenario.rates.savingsInterest)},
          Premium Bonds at {pct(scenario.rates.premiumBondRate)} (tax-free prizes). Gilts are held at
          their nominal value until retirement: their coupons aren't modelled here, so record them as
          untagged income in the expense tracker.
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
          handoff (each type feeds the same retirement pot — Premium Bonds keep their own tax-free
          pot; the GIA gain % seeds the cost basis for CGT).
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          <b>Relief at source</b>: pension contributions you tag from the joint account are topped up
          by the provider with 25% basic-rate relief (higher-rate relief you reclaim through
          self-assessment doesn't reach the pot and isn't added). <b>Outside / month</b>: money paid
          in from outside the joint account — employer contributions, salary sacrifice — already
          gross, on the last day of each month. <b>Matures</b>: a gilt holding's maturity year; the
          forecast warns if it matures before retirement. <b>Basis</b>: a GIA's recorded balance can
          carry the cost basis from the platform's statement, which re-anchors the CGT basis. ISA,
          pension annual allowance and Premium Bond limits are checked and flagged above.
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          <b>Latest actual balance</b> records what the account was <b>actually</b> worth
          (statements, valuations, prize winnings, losses). Typing a value records it as of the end
          of today and the forecast re-anchors there — earlier records are kept underneath, so past
          months stay pinned to what you recorded at the time. Change the date if the balance was
          taken on a different day, or press × to remove the record. This — not the Paid column in
          the expense tracker — is how real growth is fed in.
        </p>
        <div style={{ overflowX: "auto" }}>
        <table className="fit zebra">
          <thead>
            <tr>
              <th className="label">Account</th>
              <th>Owner</th>
              <th>Type</th>
              <th>Opening balance</th>
              <th>GIA gain %</th>
              <th title="Pension contributions tagged from the joint account get 25% basic-rate relief added">Relief at source</th>
              <th title="Paid in from outside the joint account (employer, salary sacrifice), gross, on the last day of each month">Outside / month</th>
              <th title="Gilts: the calendar year the holding matures">Matures</th>
              <th>Latest actual balance</th>
              <th>As of end of</th>
              <th title="GIA: the cost basis on the same day, from the platform's statement (blank = keep tracking it)">Basis</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => {
              const latest = latestOverride(data, a.id);
              return (
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
                          if (x.kind !== "pension") x.reliefAtSource = false;
                          if (x.kind !== "gilts") x.maturityYear = null;
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
                    {a.kind === "pension" ? (
                      <input
                        type="checkbox"
                        checked={a.reliefAtSource}
                        onChange={(ev) => editAccount(a.id, (x) => (x.reliefAtSource = ev.target.checked))}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      step={50}
                      min={0}
                      style={{ width: 90 }}
                      value={a.externalMonthlyContribution}
                      onChange={(ev) =>
                        editAccount(a.id, (x) => (x.externalMonthlyContribution = Math.max(0, parseAmount(ev.target.value))))
                      }
                    />
                  </td>
                  <td>
                    {a.kind === "gilts" ? (
                      <input
                        type="number"
                        step={1}
                        style={{ width: 70 }}
                        placeholder="year"
                        value={a.maturityYear ?? ""}
                        onChange={(ev) =>
                          editAccount(a.id, (x) => {
                            const y = Math.round(parseAmount(ev.target.value));
                            x.maturityYear = ev.target.value === "" || y < 1900 || y > 2200 ? null : y;
                          })
                        }
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      step={0.01}
                      value={latest?.value ?? ""}
                      onChange={(ev) => recordActual(a.id, parseAmount(ev.target.value))}
                    />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <input
                      type="date"
                      value={latest ? overrideDateIso(latest) : ""}
                      disabled={!latest}
                      onChange={(ev) => latest && moveActual(a.id, latest, ev.target.value)}
                    />
                    {latest && (
                      <button
                        className="ghost"
                        title="Remove this record (an earlier one, if any, takes over)"
                        onClick={() => clearActual(a.id, latest)}
                      >
                        ×
                      </button>
                    )}
                  </td>
                  <td>
                    {a.kind === "gia" && latest ? (
                      <input
                        type="number"
                        step={0.01}
                        style={{ width: 110 }}
                        placeholder="tracked"
                        value={latest.basis ?? ""}
                        onChange={(ev) =>
                          setBasis(a.id, latest, ev.target.value === "" ? null : parseAmount(ev.target.value))
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
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

    </>
  );
}
