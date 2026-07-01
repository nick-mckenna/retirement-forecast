// UK tax year runs 6 April -> 5 April. The "tax year start year" is the calendar
// year of the 6 April on which it begins (e.g. 2028 == tax year 2028/29).

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

/** Excel serial date (1900 date system) for a JS UTC date. */
export function toExcelSerial(d: Date): number {
  const epoch = Date.UTC(1899, 11, 30); // Excel's day 0, accounting for the 1900 leap bug
  return Math.round((d.getTime() - epoch) / 86400000);
}

/** The tax-year start year that a given date falls into. */
export function taxYearStartYear(d: Date): number {
  const y = d.getUTCFullYear();
  const afterApr6 = d.getUTCMonth() > 3 || (d.getUTCMonth() === 3 && d.getUTCDate() >= 6);
  return afterApr6 ? y : y - 1;
}

/** Age in whole years on a given date. */
export function ageOn(dobIso: string, on: Date): number {
  const dob = parseDate(dobIso);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < dob.getUTCMonth() ||
    (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

/** Age at 6 April of the given tax year start year. */
export function ageAtTaxYearStart(dobIso: string, startYear: number): number {
  return ageOn(dobIso, new Date(Date.UTC(startYear, 3, 6)));
}
