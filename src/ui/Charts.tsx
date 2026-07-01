import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SimResult } from "../engine/simulate";

const axisStyle = { fontSize: 11, fill: "#93a4b3" };
const gbpTick = (v: number) => `£${Math.round(v / 1000)}k`;

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>{children as any}</ResponsiveContainer>
      </div>
    </div>
  );
}

export function Charts({ result }: { result: SimResult }) {
  const nw = result.years.map((y) => ({
    year: y.taxYearStart,
    netWorth: Math.round(y.netWorthEnd),
    buffer: Math.round(y.bufferEnd),
    bufferTarget: Math.round(y.bufferTargetValue),
  }));

  const tax = result.years.map((y) => ({
    year: y.taxYearStart,
    "Nick income tax": Math.round(y.tax.nick.incomeTax),
    "Nick CGT": Math.round(y.tax.nick.cgt),
    "Tracy income tax": Math.round(y.tax.tracy.incomeTax),
    "Tracy CGT": Math.round(y.tax.tracy.cgt),
  }));

  const comp = result.rows
    .filter((r) => r.label === "Year End")
    .map((r) => ({
      year: Number(r.dateIso.slice(0, 4)),
      ISA: Math.round(r.nick.isa + r.tracy.isa),
      Pension: Math.round(r.nick.pension + r.tracy.pension),
      GIA: Math.round(r.nick.gia + r.tracy.gia),
      Savings: Math.round(r.nick.savings + r.tracy.savings),
      Gilts: Math.round(r.nick.giltsTotal + r.tracy.giltsTotal),
    }));

  return (
    <div>
      <Panel title="Net worth over time">
        <LineChart data={nw}>
          <CartesianGrid stroke="#2c3e4f" />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip formatter={(v: number) => `£${v.toLocaleString()}`} contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }} />
          <Line type="monotone" dataKey="netWorth" stroke="#4da3ff" dot={false} strokeWidth={2} />
        </LineChart>
      </Panel>

      <Panel title="Savings & Gilts buffer vs 3-year target">
        <LineChart data={nw}>
          <CartesianGrid stroke="#2c3e4f" />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip formatter={(v: number) => `£${v.toLocaleString()}`} contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="buffer" name="Buffer" stroke="#2ecc9b" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="bufferTarget" name="Target" stroke="#ffb454" dot={false} strokeDasharray="5 4" />
        </LineChart>
      </Panel>

      <Panel title="Portfolio composition (year end)">
        <AreaChart data={comp}>
          <CartesianGrid stroke="#2c3e4f" />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip formatter={(v: number) => `£${v.toLocaleString()}`} contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="Pension" stackId="1" stroke="#4da3ff" fill="#4da3ff55" />
          <Area type="monotone" dataKey="ISA" stackId="1" stroke="#c98bff" fill="#c98bff55" />
          <Area type="monotone" dataKey="GIA" stackId="1" stroke="#2ecc9b" fill="#2ecc9b55" />
          <Area type="monotone" dataKey="Gilts" stackId="1" stroke="#ffb454" fill="#ffb45455" />
          <Area type="monotone" dataKey="Savings" stackId="1" stroke="#ff6b6b" fill="#ff6b6b55" />
        </AreaChart>
      </Panel>

      <Panel title="Annual tax by person">
        <BarChart data={tax}>
          <CartesianGrid stroke="#2c3e4f" />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip formatter={(v: number) => `£${v.toLocaleString()}`} contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Nick income tax" stackId="n" fill="#4da3ff" />
          <Bar dataKey="Nick CGT" stackId="n" fill="#2c6ca8" />
          <Bar dataKey="Tracy income tax" stackId="t" fill="#c98bff" />
          <Bar dataKey="Tracy CGT" stackId="t" fill="#7a4fa8" />
        </BarChart>
      </Panel>
    </div>
  );
}
