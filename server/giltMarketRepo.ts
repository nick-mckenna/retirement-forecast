// Data access for the cached gilt market (DMO instruments and prices).

import { sql } from "./db";
import type { GiltInstrument, GiltMarket, GiltPrice } from "../src/gilts/types";
import {
  iso,
  instrumentToRow,
  priceToRow,
  rowToInstrument,
  rowToPrice,
  type GiltInstrumentRow,
  type GiltPriceRow,
} from "./giltMarketMapping";

/** Insert or update instruments (they are never deleted: a redeemed gilt's details stay). */
export async function upsertInstruments(pool: sql.ConnectionPool, instruments: GiltInstrument[]): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const i of instruments) {
      const row = instrumentToRow(i);
      const req = new sql.Request(tx);
      req.input("isin", row.isin);
      req.input("name", row.name);
      req.input("couponRate", sql.Float, row.couponRate);
      req.input("redemptionDate", row.redemptionDate); // ISO string; SQL converts to DATE
      req.input("indexLinked", sql.Bit, row.indexLinked);
      req.input("rump", sql.Bit, row.rump);
      await req.query(`
        MERGE dbo.GiltInstrument AS t
        USING (SELECT @isin AS isin) AS s ON t.isin = s.isin
        WHEN MATCHED THEN UPDATE SET name = @name, couponRate = @couponRate,
          redemptionDate = @redemptionDate, indexLinked = @indexLinked, rump = @rump,
          updatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (isin, name, couponRate, redemptionDate, indexLinked, rump)
          VALUES (@isin, @name, @couponRate, @redemptionDate, @indexLinked, @rump);`);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** Replace one trade date's prices. */
export async function replacePrices(pool: sql.ConnectionPool, priceDate: string, prices: GiltPrice[]): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).input("d", priceDate).query("DELETE FROM dbo.GiltPrice WHERE priceDate = @d");
    for (const p of prices) {
      const row = priceToRow(p);
      await new sql.Request(tx)
        .input("isin", row.isin)
        .input("priceDate", row.priceDate)
        .input("buyClean", sql.Float, row.buyClean)
        .input("buyDirty", sql.Float, row.buyDirty)
        .input("sellClean", sql.Float, row.sellClean)
        .input("sellDirty", sql.Float, row.sellDirty)
        .query(`INSERT INTO dbo.GiltPrice (isin, priceDate, buyClean, buyDirty, sellClean, sellDirty)
                VALUES (@isin, @priceDate, @buyClean, @buyDirty, @sellClean, @sellDirty)`);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** The latest trade date with prices, or null. */
export async function latestPriceDate(pool: sql.ConnectionPool): Promise<string | null> {
  const r = await pool.request().query<{ d: Date | null }>("SELECT MAX(priceDate) AS d FROM dbo.GiltPrice");
  const d = r.recordset[0]?.d;
  return d ? iso(d) : null;
}

/** Whether prices are stored for a trade date within `days` days on or before `date`. */
export async function hasPricesNear(pool: sql.ConnectionPool, date: string, days: number): Promise<boolean> {
  const r = await pool
    .request()
    .input("d", date)
    .input("n", sql.Int, days)
    .query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM dbo.GiltPrice WHERE priceDate <= @d AND priceDate > DATEADD(day, -@n, @d)",
    );
  return (r.recordset[0]?.n ?? 0) > 0;
}

/** Every instrument, the latest prices of all of them, and the full price history of `isins`
 *  (the gilts the user holds — all that past valuations need). */
export async function loadMarket(pool: sql.ConnectionPool, isins: string[]): Promise<GiltMarket> {
  const asOf = await latestPriceDate(pool);
  const instruments = await pool.request().query<GiltInstrumentRow>("SELECT * FROM dbo.GiltInstrument ORDER BY redemptionDate");
  if (asOf === null) return { asOf: null, instruments: instruments.recordset.map(rowToInstrument), prices: [] };
  const req = pool.request().input("asOf", asOf);
  const params = isins.map((isin, k) => {
    req.input(`i${k}`, isin);
    return `@i${k}`;
  });
  const where = params.length > 0 ? `priceDate = @asOf OR isin IN (${params.join(", ")})` : "priceDate = @asOf";
  const prices = await req.query<GiltPriceRow>(`SELECT * FROM dbo.GiltPrice WHERE ${where} ORDER BY isin, priceDate`);
  return {
    asOf,
    instruments: instruments.recordset.map(rowToInstrument),
    prices: prices.recordset.map(rowToPrice),
  };
}
