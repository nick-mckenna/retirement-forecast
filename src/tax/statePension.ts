import type { Person, Rates } from "../model/types";
import { grow } from "../model/rates";
import { addMonths, parseDate } from "./taxYear";

// State Pension age per the Pensions Acts 2007/2011/2014 timetable (checked 2026-11-01 against
// the published tables): 66 for those born before 6 April 1960; 66 plus 1–11 months for those
// born 6 April 1960 – 5 March 1961; 67 for 6 March 1961 – 5 April 1977; a fixed date between
// 6 May 2044 and 6 March 2046 for 6 April 1977 – 5 April 1978; 68 after that. A review could
// bring the rise to 68 forward — a person's override (statePensionAge) models that.

/** `years` + `months` after a date of birth, with a day past the target month's end falling on
 *  its last day (born 31 July 1960 → 66y 4m on 30 November 2026, as the tables specify). */
function anniversary(dob: Date, years: number, months: number): Date {
  const y = dob.getUTCFullYear() + years;
  const m = dob.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(dob.getUTCDate(), lastDay)));
}

/** The date a person reaches State Pension age under the legislated timetable. */
export function statutoryStatePensionDate(dobIso: string): Date {
  const dob = parseDate(dobIso);
  const t = dob.getTime();
  const on = (y: number, monthIndex: number, d: number) => Date.UTC(y, monthIndex, d);
  if (t < on(1960, 3, 6)) return anniversary(dob, 66, 0);
  if (t < on(1961, 2, 6)) {
    // 6 Apr – 5 May 1960 → 66y 1m, … 6 Feb – 5 Mar 1961 → 66y 11m.
    let k = 1;
    while (k < 11 && t >= on(1960, 3 + k, 6)) k++;
    return anniversary(dob, 66, k);
  }
  if (t < on(1977, 3, 6)) return anniversary(dob, 67, 0);
  if (t < on(1978, 3, 6)) {
    // 6 Apr – 5 May 1977 → 6 May 2044, then two months later per month of birth, to 6 Mar 2046.
    let b = 0;
    while (b < 11 && t >= on(1977, 4 + b, 6)) b++;
    return new Date(on(2044, 4 + 2 * b, 6));
  }
  return anniversary(dob, 68, 0);
}

/** When a person's State Pension starts: their override age (fractional years allowed, e.g.
 *  66.25 = 66y 3m) or, when it is null, the statutory date. */
export function statePensionStartDate(person: Person): Date {
  if (person.statePensionAge == null) return statutoryStatePensionDate(person.dob);
  const years = Math.floor(person.statePensionAge);
  const months = Math.round((person.statePensionAge - years) * 12);
  return anniversary(parseDate(person.dob), years, months);
}

/** Age (years, fractional) at which the statutory State Pension starts — for display. */
export function statutoryStatePensionAge(dobIso: string): number {
  const dob = parseDate(dobIso);
  const spa = statutoryStatePensionDate(dobIso);
  const months = (spa.getUTCFullYear() - dob.getUTCFullYear()) * 12 + (spa.getUTCMonth() - dob.getUTCMonth());
  return months / 12;
}

/** The annual State Pension uprating: the scenario's explicit figure, else the triple lock's
 *  floor — the higher of inflation and 2.5% (earnings growth isn't modelled). */
export function statePensionGrowth(rates: Rates): number {
  return rates.statePensionGrowth ?? Math.max(rates.inflation, 0.025);
}

/** The full annual State Pension rate in the tax year starting `startYear`, uprated from the
 *  model's first year (`statePensionAnnual` is the amount in that first modelled year). */
export function statePensionRate(person: Person, startYear: number, modelStartYear: number, growth: number): number {
  return grow(person.statePensionAnnual, growth, Math.max(0, startYear - modelStartYear));
}

/** State Pension paid for the monthly period [from, to): a twelfth of the annual rate, pro-rated
 *  for the part of the period on or after the State Pension start date. */
export function statePensionInPeriod(spaStart: Date, from: Date, to: Date, annualRate: number): number {
  const s = spaStart.getTime();
  if (s >= to.getTime()) return 0;
  const f = s <= from.getTime() ? 1 : (to.getTime() - s) / (to.getTime() - from.getTime());
  return (annualRate / 12) * f;
}

/**
 * State pension a person receives during the tax year starting `startYear` (6 April → 5 April):
 * the sum of its twelve monthly payments, each pro-rated from the State Pension start date — so
 * it matches what the engine credits month by month.
 */
export function statePensionForYear(
  person: Person,
  startYear: number,
  modelStartYear: number,
  growth: number,
): number {
  const rate = statePensionRate(person, startYear, modelStartYear, growth);
  const spa = statePensionStartDate(person);
  const yearStart = new Date(Date.UTC(startYear, 3, 6));
  let total = 0;
  for (let m = 0; m < 12; m++) {
    total += statePensionInPeriod(spa, addMonths(yearStart, m), addMonths(yearStart, m + 1), rate);
  }
  return total;
}
