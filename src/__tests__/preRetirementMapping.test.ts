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
        id: "nick-isa",
        name: "Nick ISA",
        owner: "nick",
        kind: "isa",
        openingBalance: 120000.45,
        openingGainFraction: null,
        reliefAtSource: false,
        externalMonthlyContribution: 0,
        maturityYear: null,
      },
      {
        id: "nick-gia",
        name: "Nick General Investment",
        owner: "nick",
        kind: "gia",
        openingBalance: 90000,
        openingGainFraction: 0.3,
        reliefAtSource: false,
        externalMonthlyContribution: 250.5,
        maturityYear: null,
      },
      {
        id: "tracy-pension",
        name: "Tracy Pension",
        owner: "tracy",
        kind: "pension",
        openingBalance: 50000.5,
        openingGainFraction: null,
        reliefAtSource: true,
        externalMonthlyContribution: 812.34,
        maturityYear: null,
      },
      {
        id: "tracy-premium-bonds",
        name: "Tracy Premium Bonds",
        owner: "tracy",
        kind: "premiumBonds",
        openingBalance: 42000,
        openingGainFraction: null,
        reliefAtSource: false,
        externalMonthlyContribution: 0,
        maturityYear: 2031,
      },
    ],
    overrides: [
      { accountId: "nick-isa", monthKey: "2026-09", day: null, value: 120600.12, basis: null },
      { accountId: "nick-isa", monthKey: "2026-08", day: 15, value: 120300, basis: null },
      { accountId: "nick-gia", monthKey: "2026-10", day: 3, value: 91000, basis: 64000.25 },
      // Same month recorded twice (mid-month, then month end) — both kept.
      { accountId: "tracy-premium-bonds", monthKey: "2027-01", day: null, value: 42150, basis: null },
      { accountId: "tracy-premium-bonds", monthKey: "2027-01", day: 10, value: 42090, basis: null },
    ],
  };
}

/** The mapping's deterministic override order: account, month, then day
 *  (null = end of month, after every dated record). */
function sortOverrides(overrides: PreRetirementData["overrides"]): void {
  overrides.sort(
    (a, b) =>
      a.accountId.localeCompare(b.accountId) ||
      a.monthKey.localeCompare(b.monthKey) ||
      (a.day ?? 32) - (b.day ?? 32),
  );
}

/** FLOAT columns can come back as strings depending on driver settings;
 *  the mapping must coerce them (mirrors the expense mapping test). */
function simulateDbReadback(rows: PreRetirementRows): PreRetirementRows {
  const s = (v: number | string | null) => (v == null ? null : (String(v) as unknown as number));
  return {
    state: { ...rows.state },
    accounts: rows.accounts.map((r) => ({
      ...r,
      openingBalance: s(r.openingBalance)!,
      gainFraction: s(r.gainFraction),
      externalMonthlyContribution: s(r.externalMonthlyContribution)!,
      maturityYear: s(r.maturityYear),
      reliefAtSource: r.reliefAtSource ? 1 : 0, // BIT comes back as 0/1 or a boolean
    })),
    overrides: rows.overrides.map((r) => ({ ...r, value: s(r.value)!, basis: s(r.basis) })),
  };
}

describe("pre-retirement SQL row mapping", () => {
  it("round-trips fully populated data (overrides sorted deterministically)", () => {
    const d = fullPreRetirementData();
    const back = rowsToPreRetirement(simulateDbReadback(preRetirementToRows(d)));
    const expected = structuredClone(d);
    sortOverrides(expected.overrides);
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
    expect(back.accounts[0].openingBalance).toBe(120000.45);
    expect(back.accounts[0].openingGainFraction).toBeNull();
    expect(back.accounts[1].openingGainFraction).toBe(0.3);
    expect(back.overrides.find((o) => o.monthKey === "2026-09")!.value).toBe(120600.12);
    expect(back.overrides.find((o) => o.accountId === "nick-gia")!.basis).toBe(64000.25);
    expect(back.accounts[2].reliefAtSource).toBe(true);
    expect(back.accounts[2].externalMonthlyContribution).toBe(812.34);
    expect(back.accounts[3].maturityYear).toBe(2031);
  });

  it("reads rows saved before the account settings existed with their defaults", () => {
    const rows = preRetirementToRows(fullPreRetirementData());
    for (const a of rows.accounts) {
      const r = a as unknown as Record<string, unknown>;
      delete r.reliefAtSource;
      delete r.externalMonthlyContribution;
      delete r.maturityYear;
    }
    for (const o of rows.overrides) delete (o as unknown as Record<string, unknown>).basis;
    const back = rowsToPreRetirement(rows);
    expect(back.accounts.every((a) => !a.reliefAtSource && a.externalMonthlyContribution === 0 && a.maturityYear === null)).toBe(true);
    expect(back.overrides.every((o) => o.basis === null)).toBe(true);
  });
});
