import {
  excelSerialToIso,
  isNoDataReport,
  parseCoupon,
  parseD10B,
  parseD1A,
  parseDividendDates,
  parseLongDate,
} from "../../server/dmoParse";
import { readXls } from "../../server/xls";
import { buildXls } from "./helpers/xlsBuilder";

// Synthetic grids laid out like the DMO's exports; the gilts and ISINs are made up.
const serial = (iso: string) => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86_400_000);

const D1A = [
  ["Data Date: 01-Nov-2026", "GILT MARKET", "GILTS IN ISSUE ON 30 OCTOBER 2026"],
  [],
  ["Total Amount Outstanding = £1.00 billion nominal"],
  [
    "Conventional Gilts",
    "ISIN Code",
    "Redemption Date",
    "First Issue Date",
    "Dividend Dates",
    "Current/Next \nEx-dividend Date",
    "Total Amount in Issue \n(£ million nominal)",
  ],
  ["Ultra-Short"],
  ["4 1/8% Test Gilt 2027", "GB00TEST0001", serial("2027-01-29"), serial("2022-10-13"), "29 Jan/Jul", serial("2027-01-20"), 1000],
  ["3¾% Test Gilt 2027", "GB00TEST0002", serial("2027-03-07"), serial("2024-01-10"), "7 Mar/Sep", serial("2027-02-26"), 1000],
  ["Short"],
  ["0⅞% Test Gilt 2033", "GB00TEST0003", serial("2033-07-31"), serial("2021-01-01"), "31 Jan/Jul", serial("2027-01-20"), 1000],
  ["1¼ % Test Gilt 2041", "GB00TEST0004", serial("2041-10-22"), serial("2020-01-01"), "22 Apr/Oct", serial("2027-04-13"), 1000],
  [],
  [
    "Index-linked Gilts\n(3-month Indexation Lag)",
    "ISIN Code",
    "Redemption \nDate",
    "First Issue Date",
    "Dividend Dates",
    "Current/Next Ex-dividend Date",
    "Total Amount \nin Issue",
    "Base RPI",
    "Total Amount Including Uplift",
  ],
  ["0 1/8% Index-linked Test Gilt 2029", "GB00TEST0005", serial("2029-03-22"), serial("2019-01-01"), "22 Mar/Sep", serial("2027-03-12"), 1000, "250.0", 1500],
];

const D10B = [
  ["Data Date: 01-Nov-2026", "GILT MARKET", "DMO GILT PURCHASE AND SALE SERVICE PRICES", "30 October 2026"],
  [],
  [
    "ISIN Code",
    "Gilt Name",
    "Purchase\nClean Price \n(£)",
    "Purchase \nDirty Price \n(£)",
    "Sale \nClean Price \n(£)",
    "Sale \nDirty Price \n(£)",
    "Index Ratio",
    "Redemption \nDate",
    "Rump Gilt? (Yes/No)",
  ],
  ["GB00TEST0001", "4 1/8% Test Gilt 2027", 99.98, 101.08, "99.99", "101.09", null, serial("2027-01-29"), "No"],
  ["GB00TEST0003", "0⅞% Test Gilt 2033", 76.23, 76.46, "76.38", "76.61", null, serial("2033-07-31"), "Yes"],
  ["GB00TEST0005", "0 1/8% Index-linked Test Gilt 2029", 98.1, 130.2, "98.3", "130.5", 1.32, serial("2029-03-22"), "No"],
  ["The prices quoted above are those that were available for that day's transactions."],
];

describe("DMO report parsing", () => {
  it("parses coupons from gilt names", () => {
    expect(parseCoupon("4 1/8% Treasury Gilt 2027")).toBe(0.04125);
    expect(parseCoupon("3¾% Treasury Gilt 2027")).toBe(0.0375);
    expect(parseCoupon("1¼ % Treasury Gilt 2041")).toBe(0.0125);
    expect(parseCoupon("0⅞% Green Gilt 2033")).toBe(0.00875);
    expect(parseCoupon("6% Treasury Stock 2028")).toBe(0.06);
    expect(parseCoupon("Treasury Gilt 2028")).toBeNull();
  });

  it("parses dates", () => {
    expect(excelSerialToIso(46416)).toBe("2027-01-29");
    expect(parseDividendDates("7 Jun/Dec")).toEqual({ day: 7, months: [5, 11] });
    expect(parseLongDate("GILTS IN ISSUE ON 30 OCTOBER 2026")).toBe("2026-10-30");
  });

  it("reads gilts in issue (D1A)", () => {
    const r = parseD1A(D1A);
    expect(r.reportDate).toBe("2026-10-30");
    expect(r.warnings).toEqual([]);
    expect(r.instruments.map((i) => i.isin)).toEqual([
      "GB00TEST0001",
      "GB00TEST0002",
      "GB00TEST0003",
      "GB00TEST0004",
      "GB00TEST0005",
    ]);
    const first = r.instruments[0];
    expect(first).toEqual({
      isin: "GB00TEST0001",
      name: "4 1/8% Test Gilt 2027",
      couponRate: 0.04125,
      redemptionDate: "2027-01-29",
      indexLinked: false,
      rump: false,
    });
    expect(r.instruments.find((i) => i.isin === "GB00TEST0005")!.indexLinked).toBe(true);
  });

  it("warns when the coupon dates don't follow the redemption date", () => {
    const rows = D1A.map((r) => [...r]);
    rows[5][4] = "15 Feb/Aug";
    expect(parseD1A(rows).warnings).toHaveLength(1);
  });

  it("reads prices (D10B), skipping index-linked gilts", () => {
    const r = parseD10B(D10B);
    expect(r.reportDate).toBe("2026-10-30");
    expect(r.prices).toEqual([
      { isin: "GB00TEST0001", buyClean: 99.98, buyDirty: 101.08, sellClean: 99.99, sellDirty: 101.09 },
      { isin: "GB00TEST0003", buyClean: 76.23, buyDirty: 76.46, sellClean: 76.38, sellDirty: 76.61 },
    ]);
    expect(r.rump).toEqual(["GB00TEST0003"]);
  });

  it("recognises a report for a date with no data", () => {
    const empty = [
      D10B[0],
      [],
      D10B[2],
      [null, null, null, null, "N/A", "N/A"],
      ["No information to display, please refine selection criteria"],
    ];
    expect(isNoDataReport(empty)).toBe(true);
    expect(isNoDataReport(D10B)).toBe(false);
  });

  it("fails loudly when the layout changes", () => {
    expect(() => parseD1A([["Something else entirely"]])).toThrow(/layout/);
    expect(() => parseD10B([["ISIN", "Name", "Price"]])).toThrow(/layout/);
  });

  it("reads a report through the .xls reader end to end", () => {
    const grid = readXls(buildXls([{ name: "Sheet1", rows: D10B }])).sheets[0].rows;
    expect(parseD10B(grid).prices).toHaveLength(2);
  });
});
