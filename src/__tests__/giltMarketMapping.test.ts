import {
  instrumentToRow,
  priceToRow,
  rowToInstrument,
  rowToPrice,
} from "../../server/giltMarketMapping";
import type { GiltInstrument, GiltPrice } from "../gilts/types";

const inst: GiltInstrument = {
  isin: "GB00TEST0001",
  name: "0 1/4% Test Gilt 2031",
  couponRate: 0.0025,
  redemptionDate: "2031-07-31",
  indexLinked: false,
  rump: true,
};

const price: GiltPrice = {
  isin: "GB00TEST0001",
  priceDate: "2026-10-30",
  buyClean: 80.84,
  buyDirty: 80.9,
  sellClean: 80.95,
  sellDirty: 81.01,
};

describe("gilt market SQL mapping", () => {
  it("round-trips instruments and prices", () => {
    expect(rowToInstrument(instrumentToRow(inst))).toEqual(inst);
    expect(rowToPrice(priceToRow(price))).toEqual(price);
  });

  it("maps every field", () => {
    expect(Object.keys(instrumentToRow(inst)).sort()).toEqual(Object.keys(inst).sort());
    expect(Object.keys(priceToRow(price)).sort()).toEqual(Object.keys(price).sort());
  });

  it("reads driver values: DATE as Date, BIT as number, FLOAT as string", () => {
    const back = rowToInstrument({
      ...instrumentToRow(inst),
      redemptionDate: new Date(Date.UTC(2031, 6, 31)),
      indexLinked: 0,
      rump: 1,
      couponRate: "0.0025",
    });
    expect(back).toEqual(inst);
    expect(rowToPrice({ ...priceToRow(price), priceDate: new Date(Date.UTC(2026, 9, 30)) }).priceDate).toBe(
      "2026-10-30",
    );
  });
});
