import { describe, expect, it } from "vitest";
import { simulate } from "../engine/simulate";
import { defaultScenario } from "../model/defaults";
import { statePensionForYear } from "../tax/statePension";

// Regression test for a double-counting bug: the state pension must be counted once in
// taxable non-savings income, not twice.
describe("state pension is included once in taxable income", () => {
  // Isolate the state pension: no pension pots (so no drawdown), no GIA (no dividends),
  // income funded entirely from large ISAs. Then a retiree's only non-savings income is
  // their state pension.
  const scenario = defaultScenario();
  for (const id of ["nick", "tracy"] as const) {
    scenario.balances[id].pension = 0;
    scenario.balances[id].gia = 0;
    scenario.balances[id].gilts = 0;
    scenario.balances[id].isa = 3_000_000;
    scenario.balances[id].savings = 250_000;
  }
  const result = simulate(scenario);

  // Tracy (b. 22 Apr 1970, SPA 67) reaches SPA on 22 Apr 2037 -> the 2037/38 tax year.
  it("Tracy's state pension starts (pro-rated) in the 2037/38 tax year", () => {
    const y2036 = result.years.find((yr) => yr.taxYearStart === 2036)!;
    const y2037 = result.years.find((yr) => yr.taxYearStart === 2037)!;
    const expected2037 = statePensionForYear(scenario.people.tracy, 2037, 2028, 0.03);
    const full2037 = statePensionForYear(scenario.people.tracy, 2038, 2028, 0.03);

    // Nothing the year before she reaches SPA.
    expect(y2036.tax.tracy.taxableNonSavings).toBeCloseTo(0, 0);
    // First year is present but pro-rated (partial, less than a later full year).
    expect(expected2037).toBeGreaterThan(0);
    expect(expected2037).toBeLessThan(full2037);
    expect(y2037.tax.tracy.taxableNonSavings).toBeCloseTo(expected2037, 0);
  });

  it("Tracy's taxable non-savings equals exactly her (full) state pension from 2038/39", () => {
    const y = result.years.find((yr) => yr.taxYearStart === 2038)!;
    const expected = statePensionForYear(scenario.people.tracy, 2038, 2028, 0.03);
    expect(expected).toBeGreaterThan(0);
    // Must equal the state pension counted once — a double count would be ~2x.
    expect(y.tax.tracy.taxableNonSavings).toBeCloseTo(expected, 0);
  });

  it("Nick has no state pension before his State Pension Age", () => {
    const y = result.years.find((yr) => yr.taxYearStart === 2038)!;
    expect(y.nickAge).toBeLessThan(67);
    expect(y.tax.nick.taxableNonSavings).toBeCloseTo(0, 0);
  });
});
