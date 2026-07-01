// Rate helpers. Mirrors the "Interest Rates" sheet: monthly = (1 + annual)^(1/12) - 1.

export function annualToMonthly(annual: number): number {
  return Math.pow(1 + annual, 1 / 12) - 1;
}

/** Grow a value by `annual` compounded over `years` (years may be fractional). */
export function grow(value: number, annual: number, years: number): number {
  return value * Math.pow(1 + annual, years);
}
