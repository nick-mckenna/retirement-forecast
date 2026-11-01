// How much of a pension withdrawal is taxable. Each drawdown (UFPLS-style) is 25% tax-free
// only while the person's Lump Sum Allowance lasts: the tax-free part of a lifetime's draws
// is capped at £268,275 (unchanged in the Autumn Budget 2026). Once it is used up, every
// pound drawn is taxable income.

/** The Lump Sum Allowance: the most tax-free cash a person can take from pensions in total. */
export const LUMP_SUM_ALLOWANCE = 268_275;

/** Tax-free share of each withdrawal while the allowance lasts. */
const TAX_FREE_SHARE = 0.25;

/** The tax-free cash a withdrawal of `gross` uses, given the allowance still remaining. */
export function lsaUsedBy(gross: number, lsaRemaining: number): number {
  return Math.max(0, Math.min(TAX_FREE_SHARE * gross, lsaRemaining));
}

/** The taxable part of a withdrawal of `gross`. */
export function pensionTaxable(gross: number, lsaRemaining: number): number {
  return gross - lsaUsedBy(gross, lsaRemaining);
}

/** The gross withdrawal that produces `taxable` of taxable income — the inverse of
 *  `pensionTaxable`: 75% taxable while the allowance covers the 25%, all of it after. */
export function pensionGrossForTaxable(taxable: number, lsaRemaining: number): number {
  if (taxable <= 0) return 0;
  const lsa = Math.max(0, lsaRemaining);
  // While gross ≤ 4·lsa, taxable = 0.75·gross; beyond that, the tax-free part is capped at lsa.
  return taxable <= 3 * lsa ? taxable / (1 - TAX_FREE_SHARE) : taxable + lsa;
}

/** Share of the next £1 drawn that is taxable. */
export function marginalTaxableShare(lsaRemaining: number): number {
  return lsaRemaining > 0.5 ? 1 - TAX_FREE_SHARE : 1;
}
