import { useState } from "react";
import type { ExpenseMonth } from "../../model/expenseTypes";
import type { PreRetirementData } from "../../model/preRetirementTypes";
import type { KindRates, PreRetirementResult } from "../../preretirement/project";
import { balancesAtDate } from "../../preretirement/project";
import { useStore } from "../../store/scenarioStore";
import { monthLabel } from "../../expenses/calc";
import { money } from "../format";
import { buildSnapshotSummary, shareLabel } from "../../export/snapshotSummary";
import { exportSnapshotPdf } from "../../export/snapshotPdf";

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-07-08" → "8 July 2026". */
function dateLabel(dateIso: string): string {
  return `${Number(dateIso.slice(8))} ${monthLabel(dateIso.slice(0, 7))}`;
}

/** Account values at the end of a chosen day (defaulting to today) with total
 *  net worth. Investments only — the joint current account lives in the
 *  expenses module. Numbers come from `buildSnapshotSummary`, the same source
 *  of truth the PDF export renders from. */
export function SnapshotView({
  result,
  data,
  expenseMonths,
  rates,
}: {
  result: PreRetirementResult;
  data: PreRetirementData;
  expenseMonths: ExpenseMonth[];
  rates: KindRates;
}) {
  const accounts = data.accounts;
  const scenario = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const [dateIso, setDateIso] = useState(() => toIso(new Date()));

  const balances = balancesAtDate(result, data, expenseMonths, rates, dateIso);
  const summary = buildSnapshotSummary(scenario, accounts, balances, dateIso, toIso(new Date()));

  const categoryGroups: {
    key: string;
    title: string;
    color?: string;
    rows: (typeof summary.bothCategories);
  }[] = [
    ...summary.people.map((p) => ({
      key: p.id,
      title: `${p.name} by category`,
      color: p.colorHex,
      rows: p.categories,
    })),
    { key: "both", title: "Both by category", rows: summary.bothCategories },
  ];

  const first = result.months[0];
  const last = result.months[result.months.length - 1];
  const monthKey = dateIso.slice(0, 7);
  const scopeNote = !first || !last
    ? "Nothing is modelled yet."
    : monthKey < first.key
      ? `${dateLabel(dateIso)} is before the forecast starts — showing the opening balances (start of ${monthLabel(first.key)}).`
      : monthKey > last.key
        ? `${dateLabel(dateIso)} is after the forecast ends — showing the ${monthLabel(last.key)} end balances.`
        : `Projected balances at the end of ${dateLabel(dateIso)}, re-anchored to recorded actual balances up to that day.`;

  return (
    <>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2>Snapshot date</h2>
        <div className="field">
          <label>Values as at</label>
          <input type="date" value={dateIso} onChange={(e) => e.target.value && setDateIso(e.target.value)} />
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          {scopeNote} Investments only — the joint current account is tracked in the Monthly
          expenses module.
        </p>
        <button
          className="primary"
          style={{ marginTop: 8 }}
          onClick={() => exportSnapshotPdf(scenario, accounts, balances, dateIso)}
          title="Download a PDF summary of this snapshot for a financial advisor"
        >
          Export to PDF
        </button>
      </div>

      <div className="kpi">
        <div className="box">
          <div className="v">{money(summary.netWorth)}</div>
          <div className="l">Total net worth (investments)</div>
        </div>
        {summary.people.map((p) => (
          <div className="box" key={p.id}>
            <div className="v">{money(p.total)}</div>
            <div className="l">
              {p.name} total · {shareLabel(p.shareFraction)}
            </div>
          </div>
        ))}
      </div>

      <div
        className="grid-2"
        style={{ gridTemplateColumns: "repeat(3, 1fr)", alignItems: "start", gap: 18, maxWidth: 1000, marginBottom: 18 }}
      >
        {categoryGroups.map((g) => {
          const groupTotal = g.rows.reduce((s, r) => s + r.total, 0);
          return (
            <div className="card" key={g.key}>
              <h2 style={g.color ? { color: g.color } : undefined}>{g.title}</h2>
              <table className="fit zebra">
                <tbody>
                  {g.rows.map((row) => (
                    <tr key={row.kind}>
                      <td className="label">{row.kindLabel}</td>
                      <td style={{ textAlign: "right" }}>{money(row.total)}</td>
                      <td className="muted" style={{ textAlign: "right" }}>
                        {shareLabel(row.shareFraction)}
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
        {summary.people.map((p) => (
          <div className="card" key={p.id}>
            <h2 style={{ color: p.colorHex }}>{p.name}</h2>
            <table className="fit zebra">
              <tbody>
                {p.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="label">{a.name}</td>
                    <td>
                      <span className="pill">{a.kindLabel}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>{money(a.value)}</td>
                    <td className="muted" style={{ textAlign: "right" }}>
                      {shareLabel(a.shareFraction)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th className="label" colSpan={2}>
                    Total
                  </th>
                  <th style={{ textAlign: "right" }}>{money(p.total)}</th>
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
