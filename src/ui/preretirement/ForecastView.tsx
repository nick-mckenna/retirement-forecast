import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { InvestmentAccount } from "../../model/preRetirementTypes";
import { PERSON_IDS } from "../../model/preRetirementTypes";
import type { AccountMonthCell, PreRetirementResult } from "../../preretirement/project";
import { useStore } from "../../store/scenarioStore";
import { monthLabel } from "../../expenses/calc";
import { money } from "../format";

const axisStyle = { fontSize: 11, fill: "#93a4b3" };
const gbpTick = (v: number) => `£${Math.round(v / 1000)}k`;

function cellTitle(c: AccountMonthCell): string {
  const parts = [
    `Start ${money(c.start, 2) === "—" ? "£0" : money(c.start, 2)}`,
    `Growth ${money(c.growth, 2) === "—" ? "£0" : money(c.growth, 2)}`,
  ];
  if (c.contributions !== 0) parts.push(`In ${money(c.contributions, 2)}`);
  if (c.withdrawals !== 0) parts.push(`Out ${money(c.withdrawals, 2)}`);
  parts.push(c.overridden ? `End ${money(c.end, 2)} (actual, recorded)` : `End ${money(c.end, 2)}`);
  return parts.join("  ·  ");
}

/** Net-worth chart plus the month-by-month table of every registry account. */
export function ForecastView({
  result,
  accounts,
}: {
  result: PreRetirementResult;
  accounts: InvestmentAccount[];
}) {
  const scenario = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);

  if (accounts.length === 0) {
    return (
      <div className="card">
        <h2>No accounts yet</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Add your accounts in the <b>Accounts</b> tab to start forecasting.
        </p>
      </div>
    );
  }

  if (result.months.length === 0) {
    return (
      <div className="card">
        <h2>Nothing to forecast yet</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          The forecast range is empty — the active scenario starts before the opening month set in
          the <b>Accounts</b> tab.
        </p>
      </div>
    );
  }

  const chartData = result.months.map((m) => ({
    month: m.key,
    total: Math.round(m.total),
  }));

  // Columns grouped by owner, keeping registry order within each group.
  const groups = PERSON_IDS.map((p) => ({
    person: p,
    name: scenario.people[p].name,
    accounts: accounts.filter((a) => a.owner === p),
  })).filter((g) => g.accounts.length > 0);

  return (
    <>
      <div className="card">
        <h2>Investments over time</h2>
        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2c3e4f" />
              <XAxis dataKey="month" tick={axisStyle} />
              <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
              <Tooltip
                formatter={(v: number) => `£${v.toLocaleString()}`}
                labelFormatter={(k: string) => monthLabel(k)}
                contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }}
              />
              <Line type="monotone" dataKey="total" name="Total" stroke="#4da3ff" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card">
        <h2>Month by month</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          End-of-month balances. Hover a cell for its growth and tagged flows; cells marked ●
          are recorded actual balances that re-anchor the forecast.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="fit zebra">
            <thead>
              <tr>
                <th className="label"></th>
                {groups.map((g) => (
                  <th
                    key={g.person}
                    colSpan={g.accounts.length}
                    style={{ color: g.person === "nick" ? "var(--nick)" : "var(--tracy)", textAlign: "center" }}
                  >
                    {g.name}
                  </th>
                ))}
                <th></th>
              </tr>
              <tr>
                <th className="label">Month</th>
                {groups.flatMap((g) =>
                  g.accounts.map((a) => (
                    <th key={a.id} title={a.name}>
                      {a.name}
                    </th>
                  )),
                )}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {result.months.map((m) => (
                <tr key={m.key}>
                  <td className="label" style={{ whiteSpace: "nowrap" }}>
                    {monthLabel(m.key)}
                  </td>
                  {groups.flatMap((g) =>
                    g.accounts.map((a) => {
                      const c = m.byAccount[a.id];
                      if (!c) return <td key={a.id} />;
                      const flows = c.contributions !== 0 || c.withdrawals !== 0;
                      return (
                        <td
                          key={a.id}
                          title={cellTitle(c)}
                          style={{ whiteSpace: "nowrap", fontWeight: flows ? 600 : undefined }}
                        >
                          {money(c.end)}
                          {c.overridden ? " ●" : ""}
                        </td>
                      );
                    }),
                  )}
                  <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{money(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
