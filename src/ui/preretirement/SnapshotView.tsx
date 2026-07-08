import { useState } from "react";
import type { InvestmentAccount, PreAccountKind } from "../../model/preRetirementTypes";
import { PERSON_IDS, PRE_ACCOUNT_KINDS, PRE_ACCOUNT_KIND_LABELS } from "../../model/preRetirementTypes";
import type { PreRetirementResult } from "../../preretirement/project";
import { balancesAt } from "../../preretirement/project";
import { useStore } from "../../store/scenarioStore";
import { monthLabel } from "../../expenses/calc";
import { money, pct } from "../format";

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Account values on a chosen date (defaulting to today) with total net worth.
 *  Investments only — the joint current account lives in the expenses module. */
export function SnapshotView({
  result,
  accounts,
}: {
  result: PreRetirementResult;
  accounts: InvestmentAccount[];
}) {
  const scenario = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const [dateIso, setDateIso] = useState(() => toIso(new Date()));

  const monthKey = dateIso.slice(0, 7);
  const balances = balancesAt(result, monthKey);
  const value = (id: string) => balances[id] ?? 0;
  const personAccounts = (p: (typeof PERSON_IDS)[number]) => accounts.filter((a) => a.owner === p);
  const personTotal = (p: (typeof PERSON_IDS)[number]) =>
    personAccounts(p).reduce((s, a) => s + value(a.id), 0);
  const netWorth = PERSON_IDS.reduce((s, p) => s + personTotal(p), 0);
  const share = (part: number, whole: number) => (whole > 0 ? pct(part / whole, 1) : "—");

  const kindTotals = (accts: InvestmentAccount[]) => {
    const totals = new Map<PreAccountKind, number>();
    for (const a of accts) totals.set(a.kind, (totals.get(a.kind) ?? 0) + value(a.id));
    return PRE_ACCOUNT_KINDS.filter((k) => totals.has(k)).map((k) => ({ kind: k, total: totals.get(k)! }));
  };
  const categoryGroups: { key: string; title: string; color?: string; accounts: InvestmentAccount[] }[] = [
    ...PERSON_IDS.map((p) => ({
      key: p,
      title: `${scenario.people[p].name} by category`,
      color: p === "nick" ? "var(--nick)" : "var(--tracy)",
      accounts: personAccounts(p),
    })),
    { key: "both", title: "Both by category", accounts },
  ];

  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  const clamped =
    first && last ? (monthKey < first.key ? first.key : monthKey > last.key ? last.key : monthKey) : null;

  return (
    <>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2>Snapshot date</h2>
        <div className="field">
          <label>Values as at</label>
          <input type="date" value={dateIso} onChange={(e) => e.target.value && setDateIso(e.target.value)} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Projected end-of-month balances for {clamped ? monthLabel(clamped) : "—"}
          {clamped && clamped !== monthKey ? ` (nearest modelled month to ${monthLabel(monthKey)})` : ""}.
          Investments only — the joint current account is tracked in the Monthly expenses module.
        </p>
      </div>

      <div className="kpi">
        <div className="box">
          <div className="v">{money(netWorth)}</div>
          <div className="l">Total net worth (investments)</div>
        </div>
        {PERSON_IDS.map((p) => (
          <div className="box" key={p}>
            <div className="v">{money(personTotal(p))}</div>
            <div className="l">
              {scenario.people[p].name} total · {share(personTotal(p), netWorth)}
            </div>
          </div>
        ))}
      </div>

      <div
        className="grid-2"
        style={{ gridTemplateColumns: "repeat(3, 1fr)", alignItems: "start", gap: 18, maxWidth: 1000, marginBottom: 18 }}
      >
        {categoryGroups.map((g) => {
          const groupTotal = g.accounts.reduce((s, a) => s + value(a.id), 0);
          return (
            <div className="card" key={g.key}>
              <h2 style={g.color ? { color: g.color } : undefined}>{g.title}</h2>
              <table className="fit zebra">
                <tbody>
                  {kindTotals(g.accounts).map((row) => (
                    <tr key={row.kind}>
                      <td className="label">{PRE_ACCOUNT_KIND_LABELS[row.kind]}</td>
                      <td style={{ textAlign: "right" }}>{money(row.total)}</td>
                      <td className="muted" style={{ textAlign: "right" }}>
                        {share(row.total, groupTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th className="label">Total</th>
                    <th style={{ textAlign: "right" }}>{money(groupTotal)}</th>
                    <th />
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        })}
      </div>

      <div className="grid-2" style={{ alignItems: "start", gap: 18, maxWidth: 1000 }}>
        {PERSON_IDS.map((p) => (
          <div className="card" key={p}>
            <h2 style={{ color: p === "nick" ? "var(--nick)" : "var(--tracy)" }}>{scenario.people[p].name}</h2>
            <table className="fit zebra">
              <tbody>
                {personAccounts(p).map((a) => (
                  <tr key={a.id}>
                    <td className="label">{a.name}</td>
                    <td>
                      <span className="pill">{PRE_ACCOUNT_KIND_LABELS[a.kind]}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>{money(value(a.id))}</td>
                    <td className="muted" style={{ textAlign: "right" }}>
                      {share(value(a.id), personTotal(p))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th className="label" colSpan={2}>
                    Total
                  </th>
                  <th style={{ textAlign: "right" }}>{money(personTotal(p))}</th>
                  <th />
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}
