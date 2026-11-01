import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SimResult } from "../engine/simulate";
import { INCOME_SOURCES, incomeByTaxYear, PERSON_IDS, type IncomeSource } from "../engine/ledger";
import type { PersonId, Scenario } from "../model/types";
import { CHART_SURFACE, PERSON_COLORS, PERSON_INCOME_TINTS, TOTAL_COLOR } from "./chartPalette";

const axisStyle = { fontSize: 11, fill: "#93a4b3" };
const gbpTick = (v: number) => `£${Math.round(v / 1000)}k`;
/** Legend labels in text ink — the swatch beside each carries the series colour. */
const legendText = (value: string) => <span style={{ color: "var(--muted)" }}>{value}</span>;

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {note && (
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {note}
        </p>
      )}
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>{children as any}</ResponsiveContainer>
      </div>
    </div>
  );
}

const SOURCE_LABELS: Record<IncomeSource, string> = {
  drawdown: "drawdown",
  statePension: "State Pension",
  finalIncome: "one-off income",
};

/** One tax year of the income chart: per-person segments (`nick_drawdown`, …), per-person
 *  subtotals and the household total, all rounded to whole pounds. */
type IncomeDatum = { year: number; total: number } & Record<string, number>;

const segKey = (id: PersonId, src: IncomeSource) => `${id}_${src}`;

/** A bar segment with only its top corners rounded (radius 0 = a plain rectangle). */
function topRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Recharts shape for one person's segment: the topmost non-zero segment of the stack gets
 *  the 4px rounded data-end; every segment below it gives up its top 2px as a surface gap. */
function segmentShape(id: PersonId, src: IncomeSource) {
  const idx = INCOME_SOURCES.indexOf(src);
  return (props: { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: IncomeDatum }) => {
    const { x = 0, y = 0, width = 0, height = 0, fill, payload } = props;
    if (!payload || height <= 0 || width <= 0) return <g />;
    let top = -1;
    INCOME_SOURCES.forEach((s, i) => {
      if ((payload[segKey(id, s)] ?? 0) > 0) top = i;
    });
    if (idx === top) {
      return <path d={topRoundedPath(x, y, width, height, Math.min(4, width / 2, height))} fill={fill} />;
    }
    const gap = Math.min(2, height);
    return <path d={topRoundedPath(x, y + gap, width, height - gap, 0)} fill={fill} />;
  };
}

function gbp(v: number): string {
  return `£${Math.round(v).toLocaleString("en-GB")}`;
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: color, marginRight: 6 }}
    />
  );
}

/** Hover card for the income chart: each person's subtotal with its parts, then the household. */
function IncomeTooltip({
  active,
  payload,
  names,
}: {
  active?: boolean;
  payload?: { payload: IncomeDatum }[];
  names: Record<PersonId, string>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: CHART_SURFACE, border: "1px solid #2c3e4f", padding: "8px 10px", fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Tax year {d.year}/{String((d.year + 1) % 100).padStart(2, "0")}
      </div>
      {PERSON_IDS.map((id) => (
        <div key={id} style={{ marginBottom: 6 }}>
          <div>
            <Swatch color={PERSON_COLORS[id]} />
            <b>{names[id]}</b> {gbp(d[`${id}Total`])}
          </div>
          {INCOME_SOURCES.filter((src) => d[segKey(id, src)] > 0).map((src) => (
            <div key={src} className="muted" style={{ paddingLeft: 15 }}>
              {SOURCE_LABELS[src]} {gbp(d[segKey(id, src)])}
            </div>
          ))}
        </div>
      ))}
      <div>
        <Swatch color={TOTAL_COLOR} />
        <b>Household</b> {gbp(d.total)}
      </div>
    </div>
  );
}

export function Charts({ result, scenario }: { result: SimResult; scenario: Scenario }) {
  const nickName = scenario.people.nick.name;
  const tracyName = scenario.people.tracy.name;

  const nw = result.years.map((y) => ({
    year: y.taxYearStart,
    netWorth: Math.round(y.netWorthEnd),
    buffer: Math.round(y.bufferEnd),
    bufferTarget: Math.round(y.bufferTargetValue),
  }));

  const tax = result.years.map((y) => ({
    year: y.taxYearStart,
    [`${nickName} income tax`]: Math.round(y.tax.nick.incomeTax),
    [`${nickName} CGT`]: Math.round(y.tax.nick.cgt),
    [`${tracyName} income tax`]: Math.round(y.tax.tracy.incomeTax),
    [`${tracyName} CGT`]: Math.round(y.tax.tracy.cgt),
  }));

  const income = incomeByTaxYear(
    result.rows,
    result.years.map((y) => y.taxYearStart),
  ).map((y): IncomeDatum => {
    const d: IncomeDatum = { year: y.taxYearStart, total: Math.round(y.total) } as IncomeDatum;
    for (const id of PERSON_IDS) {
      d[`${id}Total`] = Math.round(y[id]);
      for (const src of INCOME_SOURCES) d[segKey(id, src)] = Math.round(y.bySource[id][src]);
    }
    return d;
  });
  // A source nobody has in any year (e.g. no one-off income) gets no bar and no legend entry.
  const incomeSeries = PERSON_IDS.flatMap((id) =>
    INCOME_SOURCES.map((src, i) => ({ id, src, color: PERSON_INCOME_TINTS[id][i] })).filter(({ src }) =>
      income.some((d) => d[segKey(id, src)] > 0),
    ),
  );
  const names: Record<PersonId, string> = { nick: nickName, tracy: tracyName };

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
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
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
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Area type="monotone" dataKey="Pension" stackId="1" stroke="#4da3ff" fill="#4da3ff55" />
          <Area type="monotone" dataKey="ISA" stackId="1" stroke="#c98bff" fill="#c98bff55" />
          <Area type="monotone" dataKey="GIA" stackId="1" stroke="#2ecc9b" fill="#2ecc9b55" />
          <Area type="monotone" dataKey="Gilts" stackId="1" stroke="#ffb454" fill="#ffb45455" />
          <Area type="monotone" dataKey="Savings" stackId="1" stroke="#ff6b6b" fill="#ff6b6b55" />
        </AreaChart>
      </Panel>

      <Panel
        title="Annual income by person"
        note={`The Ledger's Income column per tax year, one bar each (${nickName}, then ${tracyName}), stacked by source: drawdown of the income target, State Pension and — in its year — the one-off final income. The line is the household total.`}
      >
        <ComposedChart data={income} barGap={2}>
          <CartesianGrid stroke="#2c3e4f" vertical={false} />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip content={<IncomeTooltip names={names} />} cursor={{ fill: "#ffffff0d" }} />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          {incomeSeries.map(({ id, src, color }) => (
            <Bar
              key={segKey(id, src)}
              dataKey={segKey(id, src)}
              name={`${names[id]} · ${SOURCE_LABELS[src]}`}
              stackId={id}
              fill={color}
              maxBarSize={12}
              shape={segmentShape(id, src)}
              isAnimationActive={false}
            />
          ))}
          <Line
            type="monotone"
            dataKey="total"
            name="Household total"
            stroke={TOTAL_COLOR}
            dot={false}
            strokeWidth={2}
            activeDot={{ r: 4, stroke: CHART_SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </Panel>

      <Panel title="Annual tax by person">
        <BarChart data={tax}>
          <CartesianGrid stroke="#2c3e4f" />
          <XAxis dataKey="year" tick={axisStyle} />
          <YAxis tickFormatter={gbpTick} tick={axisStyle} width={54} />
          <Tooltip formatter={(v: number) => `£${v.toLocaleString()}`} contentStyle={{ background: "#17212b", border: "1px solid #2c3e4f" }} />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Bar dataKey={`${nickName} income tax`} stackId="n" fill={PERSON_INCOME_TINTS.nick[0]} />
          <Bar dataKey={`${nickName} CGT`} stackId="n" fill={PERSON_INCOME_TINTS.nick[1]} />
          <Bar dataKey={`${tracyName} income tax`} stackId="t" fill={PERSON_INCOME_TINTS.tracy[0]} />
          <Bar dataKey={`${tracyName} CGT`} stackId="t" fill={PERSON_INCOME_TINTS.tracy[1]} />
        </BarChart>
      </Panel>
    </div>
  );
}
