// Statutory limits shared by the retirement engine and the pre-retirement checks.
// Best-known values (2025/26 onwards, unchanged by the 2026 Budget); planning aid, not advice.

/** NS&I's maximum Premium Bond holding per person. */
export const PREMIUM_BOND_LIMIT = 50_000;

/** Pension annual allowance (gross contributions per person per tax year). Simplified: no
 *  carry-forward of unused allowance and no taper for high incomes. */
export const PENSION_ANNUAL_ALLOWANCE = 60_000;

/** Money purchase annual allowance: the limit on contributions once a pension has been drawn
 *  as taxable income (flexi-access drawdown or a lump sum with a taxable part). */
export const MONEY_PURCHASE_ANNUAL_ALLOWANCE = 10_000;

/** Relief at source: a member's net contribution is grossed up by basic-rate relief (20%),
 *  i.e. the pot receives net ÷ 0.8. Higher-rate relief is reclaimed through self-assessment
 *  and never reaches the pot. */
export const RELIEF_AT_SOURCE_GROSS_UP = 1.25;
