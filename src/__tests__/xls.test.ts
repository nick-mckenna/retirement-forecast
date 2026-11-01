import { decodeRk, isOle2, readXls } from "../../server/xls";
import { buildXls } from "./helpers/xlsBuilder";

describe(".xls reader", () => {
  it("reads strings and numbers back from a synthetic workbook", () => {
    const bytes = buildXls([
      {
        name: "Report",
        rows: [
          ["Title", null, "Second"],
          [],
          ["1¼% Test Gilt 2031", "GB00TEST0001", 48060, 12345.678, 3, 0.5, -2],
          ["⅞% Test Gilt 2033", "GB00TEST0002", 99.98, 100.25],
        ],
      },
    ]);
    expect(isOle2(bytes)).toBe(true);
    const wb = readXls(bytes);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe("Report");
    const rows = wb.sheets[0].rows;
    expect(rows[0]).toEqual(["Title", null, "Second"]);
    expect(rows[2]).toEqual(["1¼% Test Gilt 2031", "GB00TEST0001", 48060, 12345.678, 3, 0.5, -2]);
    expect(rows[3]).toEqual(["⅞% Test Gilt 2033", "GB00TEST0002", 99.98, 100.25]);
  });

  it("joins a shared string split across a CONTINUE record", () => {
    for (const last of ["A long compressed string", "Unicode ⅜ string"]) {
      const wb = readXls(buildXls([{ name: "S", rows: [["first"], [last]] }], { splitSst: true }));
      expect(wb.sheets[0].rows[1][0]).toBe(last);
    }
  });

  it("reads several sheets", () => {
    const wb = readXls(buildXls([
      { name: "One", rows: [["a", 1]] },
      { name: "Two", rows: [[2, "b"]] },
    ]));
    expect(wb.sheets.map((s) => s.name)).toEqual(["One", "Two"]);
    expect(wb.sheets[1].rows[0]).toEqual([2, "b"]);
  });

  it("rejects what it can't read", () => {
    expect(() => readXls(new TextEncoder().encode("Unable to fulfil the report request"))).toThrow(/OLE2/);
    expect(() => readXls(buildXls([{ name: "S", rows: [["x"]] }], { dateMode: 1 }))).toThrow(/1904/);
  });

  it("decodes RK numbers", () => {
    expect(decodeRk((1234 << 2) | 2)).toBe(1234);
    expect(decodeRk(((-5 << 2) | 2) >>> 0)).toBe(-5);
    expect(decodeRk((12345 << 2) | 3)).toBeCloseTo(123.45, 10);
    expect(decodeRk(0x3ff00000)).toBe(1); // 1.0's high word
  });
});
