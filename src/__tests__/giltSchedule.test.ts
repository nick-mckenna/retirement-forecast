import {
  accruedPer100,
  couponsBetween,
  entitledToNextCoupon,
  exDivDate,
  fundsYear,
  lastBusinessDay,
  monthEnd,
  nextCoupon,
  prevCoupon,
  remainingCoupons,
} from "../gilts/schedule";
import type { GiltTerms } from "../gilts/types";

// Synthetic gilts — not real issues.
const g31: GiltTerms = { couponRate: 0.01, redemptionDate: "2031-07-22" };
const endOfMonth: GiltTerms = { couponRate: 0.02, redemptionDate: "2030-10-31" };

describe("gilt coupon schedule", () => {
  it("pays on the redemption day every six months", () => {
    expect(nextCoupon(g31, "2026-11-01")).toBe("2027-01-22");
    expect(prevCoupon(g31, "2026-11-01")).toBe("2026-07-22");
    expect(prevCoupon(g31, "2027-01-22")).toBe("2027-01-22"); // on the day counts as prev
    expect(nextCoupon(g31, "2027-01-22")).toBe("2027-07-22");
    expect(couponsBetween(g31, "2026-07-22", "2027-07-22")).toEqual(["2027-01-22", "2027-07-22"]);
  });

  it("clamps the day to short months", () => {
    expect(nextCoupon(endOfMonth, "2026-03-01")).toBe("2026-04-30");
    expect(nextCoupon(endOfMonth, "2026-04-30")).toBe("2026-10-31");
    expect(prevCoupon(endOfMonth, "2026-05-15")).toBe("2026-04-30");
  });

  it("stops at redemption", () => {
    expect(remainingCoupons(g31, "2030-08-01")).toEqual(["2031-01-22", "2031-07-22"]);
    expect(nextCoupon(g31, "2031-07-22")).toBeNull();
    expect(couponsBetween(g31, "2031-01-01", "2032-12-31")).toEqual(["2031-01-22", "2031-07-22"]);
  });

  it("accrues actual/actual within the period, negative when ex-dividend", () => {
    expect(accruedPer100(g31, "2026-07-22")).toBe(0);
    // 2026-07-22 → 2027-01-22 is 184 days; 92 days in, half the 0.5 coupon has accrued.
    expect(accruedPer100(g31, "2026-10-22")).toBeCloseTo((0.5 * 92) / 184, 10);
    expect(accruedPer100(g31, "2026-10-22", false)).toBeCloseTo((-0.5 * 92) / 184, 10);
    expect(accruedPer100(g31, "2031-07-22")).toBe(0);
  });

  it("goes ex-dividend seven business days before a coupon", () => {
    // 2027-01-22 is a Friday: seven weekdays back is Wednesday 2027-01-13.
    expect(exDivDate("2027-01-22")).toBe("2027-01-13");
    expect(entitledToNextCoupon(g31, "2027-01-12")).toBe(true);
    expect(entitledToNextCoupon(g31, "2027-01-13")).toBe(false);
  });

  it("maps a redemption date to the tax year it funds", () => {
    expect(fundsYear("2030-04-06")).toBe(2030);
    expect(fundsYear("2030-04-07")).toBe(2031);
    expect(fundsYear("2027-06-07")).toBe(2028);
    expect(fundsYear("2028-01-31")).toBe(2028);
  });

  it("finds month ends and business days", () => {
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(lastBusinessDay("2026-11-01")).toBe("2026-10-30"); // Sunday → Friday
    expect(lastBusinessDay("2026-10-30")).toBe("2026-10-30");
  });
});
