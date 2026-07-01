import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { buildWorkbook } from "../export/excelExport";

describe("excel export", () => {
  it("builds the three original sheets plus a tax summary, and round-trips", async () => {
    const scenario = defaultScenario();
    const result = simulate(scenario);
    const wb = buildWorkbook(scenario, result);

    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as ArrayBuffer);

    const names = wb2.worksheets.map((w) => w.name);
    expect(names).toContain("Interest Rates");
    expect(names).toContain("Income Targets");
    expect(names).toContain("Transactions");
    expect(names).toContain("Tax Summary");

    // Interest Rates: monthly formula present, annual S&S = 0.07.
    const ir = wb2.getWorksheet("Interest Rates")!;
    expect(ir.getCell("D3").value).toBeCloseTo(0.07, 6);
    expect((ir.getCell("C3").value as any).formula).toContain("^(1/12)");

    // Income Targets: first year 80,000; live inflation formula thereafter.
    const it = wb2.getWorksheet("Income Targets")!;
    expect(it.getCell("C2").value).toBeCloseTo(80000, 2);
    expect((it.getCell("C3").value as any).formula).toContain("Interest Rates");

    // Transactions: starting-balance row reproduces the original figures.
    const tx = wb2.getWorksheet("Transactions")!;
    expect(tx.getCell("A2").value).toBe("BALANCE");
    expect(tx.getCell("F2").value).toBeCloseTo(200000, 0); // Person A ISA
    expect(tx.getCell("H2").value).toBeCloseTo(1000000, 0); // Person A Pension
    // Net Worth column uses a live SUM formula on balance rows.
    expect((tx.getCell("S2").value as any).formula).toContain("SUM(F2:O2)");
  });
});
