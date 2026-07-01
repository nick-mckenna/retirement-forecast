import type { TaxYearParams } from "../model/types";

/**
 * Capital Gains Tax on GIA disposals for one person for one tax year.
 * Gilts are EXEMPT from CGT and must never be passed in here — only GIA gains.
 * The rate depends on how much basic-rate income-tax band remains unused: gains
 * falling within the remaining basic band are taxed at the lower CGT rate.
 */
export function computeCGT(
  realisedGain: number,
  basicBandRemaining: number,
  p: TaxYearParams,
): { tax: number; taxableGain: number } {
  const gain = Math.max(0, realisedGain);
  const taxableGain = Math.max(0, gain - p.cgtAnnualExempt);
  if (taxableGain === 0) return { tax: 0, taxableGain: 0 };

  const atLower = Math.min(taxableGain, Math.max(0, basicBandRemaining));
  const atHigher = taxableGain - atLower;
  const tax = atLower * p.cgtBasicRate + atHigher * p.cgtHigherRate;
  return { tax: Math.round(tax * 100) / 100, taxableGain };
}
