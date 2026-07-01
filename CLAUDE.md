# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # tsc -b then vite build -> dist/
npm test             # vitest run (all tests once)
npm run test:watch   # vitest watch mode
npx tsc --noEmit     # typecheck only (strict mode; noUnusedLocals/Parameters on)

# Run a single test file or test by name:
npx vitest run src/__tests__/incomeTax.test.ts
npx vitest run -t "higher-rate income spans two bands"
```

There is no linter configured; `tsc --noEmit` is the type gate. Tests live in `src/__tests__/`.

## What this is

A **local-first, client-only** SPA (React + TS + Vite, no backend) that models a UK couple's
retirement drawdown. It reproduces the original `NewForecast.xlsx` (kept in the repo root and used
as the golden reference for tests), fills in a full UK tax calculation, and proposes a tax-aware
buy/sell strategy. All state is a plain-data `Scenario` object persisted to `localStorage`; there is
no network I/O. `NewForecast.xlsx` is a data reference only — never a build input.

## Architecture — the data flow

Everything hangs off one pure function and one immutable input:

```
Scenario (src/model/types.ts)  ──simulate()──▶  SimResult { rows, years, warnings }
        │                        (src/engine/simulate.ts)          │
   Zustand store                                                   ├─▶ UI (src/ui/, useMemo)
 (src/store/scenarioStore.ts)                                      └─▶ Excel (src/export/excelExport.ts)
```

- **`simulate(scenario)` is the heart.** It is a pure, deterministic function: same Scenario in →
  same `SimResult` out. The UI does not call it directly — it calls **`runForecast(scenario)`**
  (`src/strategy/optimiser.ts`) inside a single `useMemo` in `src/ui/App.tsx`. `runForecast` calls
  `simulate` once for `heuristic`/`annual` tax modes; for `lifetime` mode it simulates several
  candidate pension-crystallisation strategies and returns the lowest-total-tax one. Keep the engine
  pure and side-effect free.
- **`strategy.taxMode` selects how investments are sold**: `heuristic` (fixed priority list),
  `annual` (marginal-cost greedy → minimises that year's tax), `lifetime` (searches how far to
  crystallise pension into the ISA each year to minimise total tax). See `src/strategy/drawdown.ts`
  (`raiseCash` vs `raiseCashMarginal`) and `optimiser.ts`.
- **The engine is a monthly ledger with an annual tax boundary.** For each UK tax year (6 Apr → 5 Apr)
  it: does annual start events (gilt maturities → cash, gilt coupons, Bed & ISA fill), runs 12 monthly
  steps (investment growth at the monthly S&S rate, savings interest, state pension, draw the monthly
  income need from the cash buffer), then at year end runs the **buffer refill** (sell investments),
  **gilt ladder** purchases, and finally computes income tax + CGT and posts it into the Nick/Tracy Tax
  columns. Every emitted `LedgerRow` is either a `BALANCE` snapshot or a `TRANSACTION` delta, mirroring
  the original spreadsheet's alternating structure.
- **Strategy is separated from the engine** (`src/strategy/`): `buffer.ts` (target = N years of income
  as cash+gilts), `drawdown.ts` (the tax-efficient *sell order* — a priority list of extraction steps
  per person; this is where "which investment to sell" lives), `giltLadder.ts` (rolling ladder). The
  engine calls these; they return plans, the engine applies them. Keep that boundary.
- **Tax is its own layer** (`src/tax/`): `incomeTax.ts` implements the real UK ordering
  (non-savings → savings → dividends, with PA taper, savings starting-rate band + PSA, dividend
  allowance); `cgt.ts` (gilts are intentionally CGT-exempt and must never be passed to it);
  `statePension.ts`; `taxParams.ts` holds editable per-year thresholds (2025/26 baseline, frozen to
  2028 then uprated with inflation via `projectTaxParams`/`resolveTaxParams`).

## Conventions and non-obvious constraints

- **`Scenario` is plain JSON.** The store deep-copies via `JSON.parse(JSON.stringify(...))`, so keep
  it serialisable (no Dates, class instances, functions). Dates are ISO strings; convert with helpers
  in `src/tax/taxYear.ts`.
- **Tax-year semantics matter.** "Tax year start year" means the calendar year of its 6 April. Use the
  helpers in `taxYear.ts` (`taxYearStartYear`, `ageAtTaxYearStart`) rather than raw date math.
- **Gilts are generalised** beyond the sheet's fixed T30–T35 columns into a `GiltHolding[]` list with
  real maturities; the Excel export and UI collapse them to per-person gilt totals.
- **Overrides**: auto-generated refill withdrawals are aggregated by `${year}:${person}:${source}` and
  can be replaced by a `Scenario.overrides` entry with the same key (see `applyOverrides` in
  `simulate.ts`).
- **Golden tests** (`src/__tests__/golden.test.ts`) assert the engine's monthly mechanics reproduce
  specific numbers taken verbatim from `NewForecast.xlsx` (e.g. Nick ISA 224,517 → 225,786.45). If you
  change growth/income mechanics, expect these to move and update them deliberately, not casually.
- The Excel builder is split into a pure `buildWorkbook()` (DOM-free, unit-tested via round-trip) and a
  thin `exportToExcel()` download wrapper — add new sheet logic in `buildWorkbook`.

## Disclaimer baked into the product

Default tax figures are best-known values and future-year thresholds are assumptions; the app presents
itself as a planning aid, not tax advice, and every threshold is user-editable in the Tax Parameters
tab. Preserve that framing when touching the tax layer or UI copy.
