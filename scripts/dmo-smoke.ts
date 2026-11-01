// Live smoke test of the DMO feed (not part of `npm test`; it hits www.dmo.gov.uk):
//   npx tsx scripts/dmo-smoke.ts [yyyy-mm-dd]
// Fetches the latest (or given) D1A and D10B reports, parses them and prints a summary plus a
// few gross redemption yields, without touching the database.

import { fetchOnOrBefore, londonToday } from "../server/dmoClient";
import { parseD10B, parseD1A } from "../server/dmoParse";
import { yieldFromClean } from "../src/gilts/pricing";

const date = process.argv[2] ?? londonToday();
const prices = await fetchOnOrBefore("D10B", date);
const d10b = parseD10B(prices.rows);
const d1a = parseD1A((await fetchOnOrBefore("D1A", prices.date)).rows);
const conventional = d1a.instruments.filter((i) => !i.indexLinked);
console.log(`D1A  ${d1a.reportDate}: ${conventional.length} conventional, ${d1a.instruments.length - conventional.length} index-linked`);
console.log(`D10B ${d10b.reportDate}: ${d10b.prices.length} conventional prices, rump: ${d10b.rump.join(", ") || "none"}`);
for (const w of d1a.warnings) console.log("warning:", w);
const asOf = d10b.reportDate ?? prices.date;
const byIsin = new Map(d10b.prices.map((p) => [p.isin, p]));
const unpriced = conventional.filter((i) => !byIsin.has(i.isin)).map((i) => i.name);
if (unpriced.length) console.log("no price:", unpriced.join("; "));
for (const i of conventional.slice(0, 12)) {
  const p = byIsin.get(i.isin);
  if (!p) continue;
  const y = yieldFromClean(i, asOf, (p.buyClean + p.sellClean) / 2);
  console.log(`${i.name.padEnd(34)} ${i.redemptionDate}  ${p.sellClean.toFixed(2).padStart(7)}  GRY ${(y * 100).toFixed(2)}%`);
}
