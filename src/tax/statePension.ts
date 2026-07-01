import type { Person } from "../model/types";
import { grow } from "../model/rates";
import { parseDate } from "./taxYear";

/**
 * State pension a person receives during the tax year starting `startYear` (6 April → 5 April).
 * Payable from the day they reach State Pension Age (their SPA-th birthday); the first tax year is
 * pro-rated for the part of the year on/after that date. The annual amount is inflated from the
 * model start year.
 */
export function statePensionForYear(
  person: Person,
  startYear: number,
  modelStartYear: number,
  inflation: number,
): number {
  const dob = parseDate(person.dob);
  const spa = Date.UTC(
    dob.getUTCFullYear() + person.statePensionAge,
    dob.getUTCMonth(),
    dob.getUTCDate(),
  );
  const yearStart = Date.UTC(startYear, 3, 6); // 6 April startYear
  const yearEnd = Date.UTC(startYear + 1, 3, 6); // 6 April startYear+1

  if (spa >= yearEnd) return 0; // SPA not yet reached within this tax year

  const full = grow(
    person.statePensionAnnual,
    inflation,
    Math.max(0, startYear - modelStartYear),
  );
  if (spa <= yearStart) return full; // SPA reached before/at the start of the year

  // Partial first year: pro-rate by the fraction of the tax year on/after the SPA date.
  const fraction = (yearEnd - spa) / (yearEnd - yearStart);
  return full * fraction;
}
