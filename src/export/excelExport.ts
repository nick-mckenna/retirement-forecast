import ExcelJS from "exceljs";
import type { Scenario } from "../model/types";
import type { SimResult } from "../engine/simulate";
import { buildIncomeTargets, resolveIncome } from "../model/incomeTargets";
import { parseDate } from "../tax/taxYear";

const GBP = '"£"#,##0;[Red]-"£"#,##0';
const PCT = "0.000%";
const DATE = "dd/mm/yyyy";

/** Build the workbook mirroring the original three-sheet layout (pure; no DOM). */
export function buildWorkbook(scenario: Scenario, result: SimResult): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Retirement Forecast";
  wb.created = parseDate(scenario.startDate);

  buildInterestRates(wb, scenario);
  buildIncomeTargetsSheet(wb, scenario);
  buildTransactions(wb, result);
  buildTaxSummary(wb, result);
  buildDisposals(wb, result);
  return wb;
}

/** Build an .xlsx mirroring the original three-sheet layout and trigger a download. */
export async function exportToExcel(scenario: Scenario, result: SimResult): Promise<void> {
  const wb = buildWorkbook(scenario, result);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${scenario.name.replace(/[^\w -]/g, "")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildInterestRates(wb: ExcelJS.Workbook, scenario: Scenario): void {
  const ws = wb.addWorksheet("Interest Rates");
  ws.getCell("C1").value = "Monthly";
  ws.getCell("D1").value = "Annual";
  const rows: [string, number][] = [
    ["Inflation", scenario.rates.inflation],
    ["S&S", scenario.rates.investmentGrowth],
    ["Savings", scenario.rates.savingsInterest],
  ];
  rows.forEach(([label, annual], i) => {
    const r = i + 2;
    ws.getCell(`B${r}`).value = label;
    // Live monthly formula, exactly as in the original sheet.
    ws.getCell(`C${r}`).value = { formula: `(1+D${r})^(1/12)-1` };
    ws.getCell(`C${r}`).numFmt = PCT;
    ws.getCell(`D${r}`).value = annual;
    ws.getCell(`D${r}`).numFmt = PCT;
  });
  ws.getColumn(2).width = 12;
}

function buildIncomeTargetsSheet(wb: ExcelJS.Workbook, scenario: Scenario): void {
  const ws = wb.addWorksheet("Income Targets");
  ws.addRow(["Tax Year Start", "Tax Year End", "Target Annual Income", "Target Monthly Income"]);
  const targets = buildIncomeTargets(resolveIncome(scenario));
  targets.forEach((t, i) => {
    const r = i + 2;
    ws.getCell(`A${r}`).value = t.startYear;
    ws.getCell(`B${r}`).value = t.endYear;
    if (i === 0) {
      ws.getCell(`C${r}`).value = t.annual;
    } else {
      // C[n] = C[n-1] * inflation + C[n-1]  (matches original formula)
      ws.getCell(`C${r}`).value = { formula: `C${r - 1}*'Interest Rates'!$D$2+C${r - 1}` };
    }
    ws.getCell(`C${r}`).numFmt = GBP;
    ws.getCell(`D${r}`).value = { formula: `C${r}/12` };
    ws.getCell(`D${r}`).numFmt = GBP;
  });
  ws.columns.forEach((c) => (c.width = 20));
}

function buildTransactions(wb: ExcelJS.Workbook, result: SimResult): void {
  const ws = wb.addWorksheet("Transactions");
  const headers = [
    "Type",
    "Description",
    "Date",
    "Nick Income",
    "Tracy Income",
    "Nick ISA",
    "Tracy ISA",
    "Nick Pension",
    "Tracy Pension",
    "Nick GIA",
    "Tracy GIA",
    "Nick Savings",
    "Tracy Savings",
    "Nick Gilts",
    "Tracy Gilts",
    "Nick Tax",
    "Tracy Tax",
    "Savings & Gilts",
    "Net Worth",
  ];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };

  for (const row of result.rows) {
    const excelRow = ws.addRow([
      row.type,
      row.label,
      parseDate(row.dateIso),
      row.nick.income,
      row.tracy.income,
      row.nick.isa,
      row.tracy.isa,
      row.nick.pension,
      row.tracy.pension,
      row.nick.gia,
      row.tracy.gia,
      row.nick.savings,
      row.tracy.savings,
      row.nick.giltsTotal,
      row.tracy.giltsTotal,
      row.nick.tax,
      row.tracy.tax,
      row.type === "BALANCE" ? row.savingsAndGilts : null,
      row.type === "BALANCE" ? row.netWorth : null,
    ]);
    excelRow.getCell(3).numFmt = DATE;
    for (let c = 4; c <= 19; c++) excelRow.getCell(c).numFmt = GBP;
    // Live aggregate formulas on BALANCE rows, mirroring the original AD/AF columns.
    if (row.type === "BALANCE") {
      const r = excelRow.number;
      excelRow.getCell(18).value = { formula: `L${r}+M${r}+N${r}+O${r}` };
      excelRow.getCell(19).value = { formula: `SUM(F${r}:O${r})` };
    }
  }
  ws.columns.forEach((c) => (c.width = 14));
  ws.getColumn(2).width = 22;
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function buildDisposals(wb: ExcelJS.Workbook, result: SimResult): void {
  const ws = wb.addWorksheet("Disposals");
  ws.addRow([
    "Tax Year",
    "Nick Pension",
    "Nick GIA",
    "Nick ISA",
    "Tracy Pension",
    "Tracy GIA",
    "Tracy ISA",
    "Bed & ISA",
    "Gilts Matured",
    "Gain Realised",
    "Total Sold",
  ]);
  ws.getRow(1).font = { bold: true };
  for (const y of result.years) {
    const d = y.disposals;
    const total =
      d.sales.nick.pension + d.sales.nick.gia + d.sales.nick.isa +
      d.sales.tracy.pension + d.sales.tracy.gia + d.sales.tracy.isa +
      d.giltMaturities.nick + d.giltMaturities.tracy;
    const r = ws.addRow([
      `${y.taxYearStart}/${y.taxYearStart + 1}`,
      d.sales.nick.pension,
      d.sales.nick.gia,
      d.sales.nick.isa,
      d.sales.tracy.pension,
      d.sales.tracy.gia,
      d.sales.tracy.isa,
      d.isaFill.nick + d.isaFill.tracy,
      d.giltMaturities.nick + d.giltMaturities.tracy,
      d.realisedGain.nick + d.realisedGain.tracy,
      total,
    ]);
    for (let c = 2; c <= 11; c++) r.getCell(c).numFmt = GBP;
  }
  ws.columns.forEach((c) => (c.width = 14));
}

function buildTaxSummary(wb: ExcelJS.Workbook, result: SimResult): void {
  const ws = wb.addWorksheet("Tax Summary");
  ws.addRow([
    "Tax Year",
    "Nick Age",
    "Tracy Age",
    "Income Target",
    "Buffer Target",
    "Buffer End",
    "Net Worth End",
    "Nick Income Tax",
    "Nick CGT",
    "Tracy Income Tax",
    "Tracy CGT",
    "Total Tax",
  ]);
  ws.getRow(1).font = { bold: true };
  for (const y of result.years) {
    const total = y.tax.nick.total + y.tax.tracy.total;
    const r = ws.addRow([
      `${y.taxYearStart}/${y.taxYearStart + 1}`,
      y.nickAge,
      y.tracyAge,
      y.incomeTarget,
      y.bufferTargetValue,
      y.bufferEnd,
      y.netWorthEnd,
      y.tax.nick.incomeTax,
      y.tax.nick.cgt,
      y.tax.tracy.incomeTax,
      y.tax.tracy.cgt,
      total,
    ]);
    for (let c = 4; c <= 12; c++) r.getCell(c).numFmt = GBP;
  }
  ws.columns.forEach((c) => (c.width = 15));
}
