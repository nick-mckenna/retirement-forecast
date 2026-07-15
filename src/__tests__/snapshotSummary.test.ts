import { describe, expect, it } from "vitest";
import type { PersonId, Scenario } from "../model/types";
import type { InvestmentAccount, PreAccountKind } from "../model/preRetirementTypes";
import { buildSnapshotSummary, shareLabel } from "../export/snapshotSummary";
import { buildSnapshotPdf } from "../export/snapshotPdf";

// Only `scenario.people[p].name` is read by the summary builder, so a tiny
// synthetic stub is enough (all figures below are invented).
const scenario = {
  people: { nick: { name: "Alice" }, tracy: { name: "Bob" } },
} as unknown as Scenario;

function acct(id: string, owner: PersonId, kind: PreAccountKind, name = id): InvestmentAccount {
  return { id, name, owner, kind, openingBalance: 0, openingGainFraction: null };
}

// Alice: two ISAs (aggregate to one category), a pension and a GIA. Bob: savings + gilts.
const accounts: InvestmentAccount[] = [
  acct("a-isa1", "nick", "isa", "Alice ISA 1"),
  acct("a-isa2", "nick", "isa", "Alice ISA 2"),
  acct("a-pension", "nick", "pension", "Alice Pension"),
  acct("a-gia", "nick", "gia", "Alice GIA"),
  acct("b-savings", "tracy", "savings", "Bob Savings"),
  acct("b-gilts", "tracy", "gilts", "Bob Gilts"),
];
const balances: Record<string, number> = {
  "a-isa1": 100_000,
  "a-isa2": 50_000,
  "a-pension": 200_000,
  "a-gia": 30_000,
  "b-savings": 40_000,
  "b-gilts": 10_000,
};

describe("buildSnapshotSummary", () => {
  const summary = buildSnapshotSummary(scenario, accounts, balances, "2026-07-08", "2026-07-15");

  it("sums net worth and per-person totals/shares", () => {
    expect(summary.netWorth).toBe(430_000);
    const alice = summary.people[0];
    const bob = summary.people[1];
    expect(alice.id).toBe("nick");
    expect(alice.name).toBe("Alice");
    expect(alice.total).toBe(380_000);
    expect(bob.total).toBe(50_000);
    expect(alice.shareFraction).toBeCloseTo(380_000 / 430_000, 10);
    expect(bob.shareFraction).toBeCloseTo(50_000 / 430_000, 10);
  });

  it("builds the couple label and formatted dates", () => {
    expect(summary.coupleLabel).toBe("Alice & Bob");
    expect(summary.asAtLabel).toBe("8 July 2026");
    expect(summary.preparedLabel).toBe("15 July 2026");
  });

  it("groups categories by kind, ordered by PRE_ACCOUNT_KINDS, with shares of the group total", () => {
    const alice = summary.people[0];
    expect(alice.categories.map((c) => c.kind)).toEqual(["isa", "pension", "gia"]);
    expect(alice.categories.map((c) => c.total)).toEqual([150_000, 200_000, 30_000]);
    expect(alice.categories[0].kindLabel).toBe("ISA");
    expect(alice.categories[0].shareFraction).toBeCloseTo(150_000 / 380_000, 10);

    expect(summary.people[1].categories.map((c) => c.kind)).toEqual(["savings", "gilts"]);
  });

  it("computes the combined 'both' breakdown across both people", () => {
    expect(summary.bothCategories.map((c) => c.kind)).toEqual([
      "isa",
      "pension",
      "gia",
      "savings",
      "gilts",
    ]);
    const both = Object.fromEntries(summary.bothCategories.map((c) => [c.kind, c.total]));
    expect(both).toEqual({ isa: 150_000, pension: 200_000, gia: 30_000, savings: 40_000, gilts: 10_000 });
    // Share of net worth.
    const isa = summary.bothCategories[0];
    expect(isa.shareFraction).toBeCloseTo(150_000 / 430_000, 10);
  });

  it("maps each account with its kind label and share of the owner's total", () => {
    const alice = summary.people[0];
    expect(alice.accounts).toHaveLength(4);
    const isa1 = alice.accounts.find((a) => a.id === "a-isa1")!;
    expect(isa1.name).toBe("Alice ISA 1");
    expect(isa1.kindLabel).toBe("ISA");
    expect(isa1.value).toBe(100_000);
    expect(isa1.shareFraction).toBeCloseTo(100_000 / 380_000, 10);
  });

  it("uses null shares (rendered '—') when the whole is 0, and 0.0% when the part is 0", () => {
    const empty = buildSnapshotSummary(scenario, [], {}, "2026-07-08", "2026-07-15");
    expect(empty.netWorth).toBe(0);
    expect(empty.people[0].total).toBe(0);
    expect(empty.people[0].shareFraction).toBeNull();
    expect(empty.bothCategories).toEqual([]);
    expect(shareLabel(null)).toBe("—");

    // Alice holds everything, Bob nothing, but net worth is positive.
    const oneSided = buildSnapshotSummary(
      scenario,
      [acct("solo", "nick", "isa")],
      { solo: 100_000 },
      "2026-07-08",
      "2026-07-15",
    );
    expect(oneSided.people[0].shareFraction).toBe(1);
    expect(oneSided.people[1].shareFraction).toBe(0);
    expect(shareLabel(oneSided.people[1].shareFraction)).toBe("0.0%");
  });
});

describe("buildSnapshotPdf", () => {
  it("produces a non-empty PDF document without throwing", () => {
    const summary = buildSnapshotSummary(scenario, accounts, balances, "2026-07-08", "2026-07-15");
    const buf = buildSnapshotPdf(summary).output("arraybuffer");
    expect(buf.byteLength).toBeGreaterThan(1000);
    // PDF magic bytes "%PDF-".
    const head = Array.from(new Uint8Array(buf.slice(0, 5)));
    expect(head).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("handles an empty registry (net worth 0) without throwing", () => {
    const empty = buildSnapshotSummary(scenario, [], {}, "2026-07-08", "2026-07-15");
    expect(() => buildSnapshotPdf(empty).output("arraybuffer")).not.toThrow();
  });
});
