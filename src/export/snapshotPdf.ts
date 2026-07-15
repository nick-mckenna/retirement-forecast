// PDF export for the Pre-retirement Snapshot — a self-contained summary to
// hand a financial advisor. Mirrors src/export/excelExport.ts: a pure,
// DOM-free builder (`buildSnapshotPdf`, unit-tested) plus a thin download
// wrapper (`exportSnapshotPdf`). Numbers come from `buildSnapshotSummary`, the
// same source of truth the on-screen Snapshot view renders from.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { UserOptions } from "jspdf-autotable";
import type { Scenario } from "../model/types";
import type { InvestmentAccount } from "../model/preRetirementTypes";
import { money } from "../ui/format";
import type { CategoryRow, PersonSummary, SnapshotSummary } from "./snapshotSummary";
import { buildSnapshotSummary, shareLabel } from "./snapshotSummary";

const MARGIN = 40;
const DARK: [number, number, number] = [31, 43, 56];
const MUTED: [number, number, number] = [110, 122, 134];
const RULE: [number, number, number] = [223, 228, 233];
const FOOT_FILL: [number, number, number] = [237, 240, 243];

/** The Y coordinate the last table finished at (autotable records it on doc). */
function lastY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 0;
}

function baseTableOptions(
  startY: number,
  headFill: string | [number, number, number],
): UserOptions {
  return {
    startY,
    theme: "striped",
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 10, cellPadding: 5, lineColor: RULE, lineWidth: 0.5 },
    headStyles: { fillColor: headFill, textColor: [255, 255, 255], fontStyle: "bold" },
    footStyles: { fillColor: FOOT_FILL, textColor: DARK, fontStyle: "bold" },
  };
}

/** A bold section heading; returns the Y to start the following table at. */
function heading(doc: jsPDF, text: string, y: number): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...DARK);
  doc.text(text, MARGIN, y);
  return y + 8;
}

/** A per-kind breakdown table with a Total footer; returns the next Y. */
function categoryTable(
  doc: jsPDF,
  y: number,
  title: string,
  rows: CategoryRow[],
  headFill: string | [number, number, number],
): number {
  const total = rows.reduce((s, r) => s + r.total, 0);
  autoTable(doc, {
    ...baseTableOptions(y, headFill),
    head: [[title, "Value", "Share"]],
    body: rows.map((r) => [r.kindLabel, money(r.total), shareLabel(r.shareFraction)]),
    foot: [["Total", money(total), ""]],
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });
  return lastY(doc) + 14;
}

/** One person's account list with a Total footer; returns the next Y. */
function accountTable(doc: jsPDF, y: number, person: PersonSummary): number {
  autoTable(doc, {
    ...baseTableOptions(y, person.colorHex),
    head: [[person.name, "Type", "Value", "Share"]],
    body: person.accounts.map((a) => [
      a.name,
      a.kindLabel,
      money(a.value),
      shareLabel(a.shareFraction),
    ]),
    foot: [["Total", "", money(person.total), ""]],
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" } },
  });
  return lastY(doc) + 14;
}

/** Build the snapshot summary PDF (pure; no DOM). */
export function buildSnapshotPdf(summary: SnapshotSummary): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setProperties({ title: `${summary.title} — ${summary.coupleLabel}`, creator: "Retirement Forecast" });
  const pageW = doc.internal.pageSize.getWidth();

  // ---- Header ----
  let y = 54;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...DARK);
  doc.text(summary.title, MARGIN, y);

  y += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(...MUTED);
  doc.text(`${summary.coupleLabel} · as at ${summary.asAtLabel}`, MARGIN, y);

  y += 15;
  doc.setFontSize(9.5);
  doc.text(`Prepared ${summary.preparedLabel}`, MARGIN, y);

  y += 12;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, pageW - MARGIN, y);
  y += 22;

  // ---- Summary ----
  y = heading(doc, "Summary", y);
  autoTable(doc, {
    ...baseTableOptions(y, DARK),
    head: [["", "Value", "Share"]],
    body: [
      ["Total net worth (investments)", money(summary.netWorth), ""],
      ...summary.people.map((p) => [`${p.name} total`, money(p.total), shareLabel(p.shareFraction)]),
    ],
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" } },
  });
  y = lastY(doc) + 22;

  // ---- By category ----
  y = heading(doc, "By category", y);
  for (const p of summary.people) {
    y = categoryTable(doc, y, `${p.name} by category`, p.categories, p.colorHex);
  }
  y = categoryTable(doc, y, "Both by category", summary.bothCategories, DARK);
  y += 8;

  // ---- Accounts ----
  y = heading(doc, "Accounts", y);
  for (const p of summary.people) {
    y = accountTable(doc, y, p);
  }

  return doc;
}

/** yyyy-mm-dd for a Date, in local time. */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Build the snapshot PDF and trigger a browser download. */
export function exportSnapshotPdf(
  scenario: Scenario,
  accounts: InvestmentAccount[],
  balances: Record<string, number>,
  dateIso: string,
): void {
  const summary = buildSnapshotSummary(scenario, accounts, balances, dateIso, toIso(new Date()));
  const doc = buildSnapshotPdf(summary);
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${scenario.name.replace(/[^\w -]/g, "")} - snapshot.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
