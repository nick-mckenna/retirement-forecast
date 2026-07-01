import { useState } from "react";
import type { SimResult } from "../engine/simulate";
import type { LedgerRow } from "../engine/ledger";
import { parseDate, taxYearStartYear } from "../tax/taxYear";
import { classForNumber, money, shortDate } from "./format";
import { useRowSelection } from "./useRowSelection";

type FilterMode = "calendar" | "tax";

/** The bucket key a row falls into for the current filter mode. */
function bucketOf(row: LedgerRow, mode: FilterMode): string {
  if (mode === "calendar") return row.dateIso.slice(0, 4);
  return String(taxYearStartYear(parseDate(row.dateIso)));
}

function bucketLabel(key: string, mode: FilterMode): string {
  return mode === "calendar" ? key : `${key}/${Number(key) + 1}`;
}

function cell(v: number) {
  if (v === 0) return <td className="muted">—</td>;
  return <td className={classForNumber(v)}>{money(v, Math.abs(v) < 1000 ? 2 : 0)}</td>;
}

function Row({
  row,
  className,
  onClick,
}: {
  row: LedgerRow;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr className={className} onClick={onClick}>
      <td className="label">
        <span className="pill">{row.type === "BALANCE" ? "BAL" : "TX"}</span>
      </td>
      <td className="label">{row.label}</td>
      <td>{shortDate(row.dateIso)}</td>
      {cell(row.nick.income)}
      {cell(row.tracy.income)}
      {cell(row.nick.isa)}
      {cell(row.tracy.isa)}
      {cell(row.nick.pension)}
      {cell(row.tracy.pension)}
      {cell(row.nick.gia)}
      {cell(row.tracy.gia)}
      {cell(row.nick.savings)}
      {cell(row.tracy.savings)}
      {cell(row.nick.giltsTotal)}
      {cell(row.tracy.giltsTotal)}
      {cell(row.nick.tax)}
      {cell(row.tracy.tax)}
      <td>{row.type === "BALANCE" ? money(row.savingsAndGilts) : "—"}</td>
      <td>{row.type === "BALANCE" ? money(row.netWorth) : "—"}</td>
    </tr>
  );
}

const COPY_HEADERS = [
  "Type", "Description", "Date", "Nick Income", "Tracy Income", "Nick ISA", "Tracy ISA",
  "Nick Pension", "Tracy Pension", "Nick GIA", "Tracy GIA", "Nick Savings", "Tracy Savings",
  "Nick Gilts", "Tracy Gilts", "Nick Tax", "Tracy Tax", "Savings & Gilts", "Net Worth",
];

function rowValues(r: LedgerRow): (string | number)[] {
  return [
    r.type, r.label, shortDate(r.dateIso),
    r.nick.income, r.tracy.income, r.nick.isa, r.tracy.isa, r.nick.pension, r.tracy.pension,
    r.nick.gia, r.tracy.gia, r.nick.savings, r.tracy.savings, r.nick.giltsTotal, r.tracy.giltsTotal,
    r.nick.tax, r.tracy.tax,
    r.type === "BALANCE" ? Math.round(r.savingsAndGilts) : "",
    r.type === "BALANCE" ? Math.round(r.netWorth) : "",
  ];
}

export function LedgerTable({ result }: { result: SimResult }) {
  const [mode, setMode] = useState<FilterMode>("calendar");
  const [year, setYear] = useState<string>("all");
  const [copied, setCopied] = useState(false);
  const { selected, toggle, rowClass } = useRowSelection();

  const buckets = Array.from(new Set(result.rows.map((r) => bucketOf(r, mode)))).sort();
  const rows = year === "all" ? result.rows : result.rows.filter((r) => bucketOf(r, mode) === year);

  const selectedRow = typeof selected === "number" ? rows[selected] : undefined;
  const copyRow = () => {
    if (!selectedRow) return;
    const vals = rowValues(selectedRow);
    const text = COPY_HEADERS.map((h, i) => `${h}\t${vals[i]}`).join("\n");
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2>Transactions ledger</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="ghost" disabled={!selectedRow} onClick={copyRow}>
            {copied ? "Copied ✓" : "Copy row"}
          </button>
          <label className="muted" style={{ fontSize: 13 }}>
            Filter by
          </label>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as FilterMode);
              setYear("all"); // buckets differ between modes; reset selection
            }}
          >
            <option value="calendar">Calendar year</option>
            <option value="tax">Tax year</option>
          </select>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="all">All ({result.rows.length} rows)</option>
            {buckets.map((b) => (
              <option key={b} value={b}>
                {bucketLabel(b, mode)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ overflowX: "auto", maxHeight: "72vh", overflowY: "auto" }}>
        <table className="sticky-cols">
          <thead>
            <tr>
              <th className="label"></th>
              <th className="label">Description</th>
              <th>Date</th>
              <th>Nick Inc</th>
              <th>Tracy Inc</th>
              <th>Nick ISA</th>
              <th>Tracy ISA</th>
              <th>Nick Pen</th>
              <th>Tracy Pen</th>
              <th>Nick GIA</th>
              <th>Tracy GIA</th>
              <th>Nick Sav</th>
              <th>Tracy Sav</th>
              <th>Nick Gilts</th>
              <th>Tracy Gilts</th>
              <th>Nick Tax</th>
              <th>Tracy Tax</th>
              <th>Sav & Gilts</th>
              <th>Net Worth</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Row
                key={i}
                row={r}
                className={rowClass(i, r.type === "BALANCE" ? "balance" : "")}
                onClick={() => toggle(i)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
