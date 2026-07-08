import { describe, expect, it } from "vitest";
import type { PreRetirementData } from "../model/preRetirementTypes";
import { defaultPreRetirementData } from "../model/preRetirementTypes";
import {
  preRetirementToRows,
  rowsToPreRetirement,
  type PreRetirementRows,
} from "../../server/preRetirementMapping";

/** Pre-retirement data with every field exercised in both states:
 *  gainFraction set (gia) and null, multiple same-kind accounts, overrides. */
function fullPreRetirementData(): PreRetirementData {
  return {
    openingMonth: "2026-07",
    accounts: [
      {
        id: "nick-vanguard-isa",
        name: "Nick Vanguard ISA",
        owner: "nick",
        kind: "isa",
        openingBalance: 224517.33,
        openingGainFraction: null,
      },
      {
        id: "nick-vanguard-gia",
        name: "Nick Vanguard General Investment",
        owner: "nick",
        kind: "gia",
        openingBalance: 90000,
        openingGainFraction: 0.3,
      },
      {
        id: "tracy-royal-london",
        name: "Tracy Royal London",
        owner: "tracy",
        kind: "pension",
        openingBalance: 50000.5,
        openingGainFraction: null,
      },
      {
        id: "tracy-premium-bonds",
        name: "Tracy Premium Bonds",
        owner: "tracy",
        kind: "premiumBonds",
        openingBalance: 42000,
        openingGainFraction: null,
      },
    ],
    overrides: [
      { accountId: "nick-vanguard-isa", monthKey: "2026-09", value: 226100.12 },
      { accountId: "nick-vanguard-isa", monthKey: "2026-08", value: 225000 },
      { accountId: "tracy-premium-bonds", monthKey: "2027-01", value: 42150 },
    ],
  };
}

/** FLOAT columns can come back as strings depending on driver settings;
 *  the mapping must coerce them (mirrors the expense mapping test). */
function simulateDbReadback(rows: PreRetirementRows): PreRetirementRows {
  const s = (v: number | string | null) => (v == null ? null : (String(v) as unknown as number));
  return {
    state: { ...rows.state },
    accounts: rows.accounts.map((r) => ({ ...r, openingBalance: s(r.openingBalance)!, gainFraction: s(r.gainFraction) })),
    overrides: rows.overrides.map((r) => ({ ...r, value: s(r.value)! })),
  };
}

describe("pre-retirement SQL row mapping", () => {
  it("round-trips fully populated data (overrides sorted deterministically)", () => {
    const d = fullPreRetirementData();
    const back = rowsToPreRetirement(simulateDbReadback(preRetirementToRows(d)));
    const expected = structuredClone(d);
    expected.overrides.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.monthKey.localeCompare(b.monthKey));
    expect(back).toEqual(expected);
  });

  it("round-trips the default (fresh-install) registry", () => {
    const d = defaultPreRetirementData();
    const back = rowsToPreRetirement(simulateDbReadback(preRetirementToRows(d)));
    expect(back).toEqual(d);
  });

  it("covers every pre-retirement field (guards against silently dropping new ones)", () => {
    const d = fullPreRetirementData();
    const back = rowsToPreRetirement(simulateDbReadback(preRetirementToRows(d)));
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(back)).toEqual(keys(d));
    expect(keys(back.accounts[0])).toEqual(keys(d.accounts[0]));
    expect(keys(back.overrides[0])).toEqual(keys(d.overrides[0]));
  });

  it("preserves account order via sortOrder and renames owner ↔ ownerId", () => {
    const d = fullPreRetirementData();
    const rows = preRetirementToRows(d);
    expect(rows.accounts.map((a) => a.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(rows.accounts[2].ownerId).toBe("tracy");
    expect(rows.state.id).toBe(1);
    // Shuffle rows; read side must restore registry order.
    const shuffled = { ...rows, accounts: [...rows.accounts].reverse() };
    const back = rowsToPreRetirement(shuffled);
    expect(back.accounts.map((a) => a.id)).toEqual(d.accounts.map((a) => a.id));
  });

  it("preserves float precision and null gain fractions", () => {
    const back = rowsToPreRetirement(simulateDbReadback(preRetirementToRows(fullPreRetirementData())));
    expect(back.accounts[0].openingBalance).toBe(224517.33);
    expect(back.accounts[0].openingGainFraction).toBeNull();
    expect(back.accounts[1].openingGainFraction).toBe(0.3);
    expect(back.overrides.find((o) => o.monthKey === "2026-09")!.value).toBe(226100.12);
  });
});
