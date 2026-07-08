# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # API server (127.0.0.1:5174) + Vite dev server (localhost:5173) via concurrently
npm run server       # persistence API server only (tsx server/index.ts)
npm run build        # tsc -b, tsc -p server/tsconfig.json, then vite build -> dist/
npm test             # vitest run (all tests once)
npm run test:watch   # vitest watch mode
npx tsc --noEmit     # typecheck the app (strict mode; noUnusedLocals/Parameters on)
npx tsc -p server/tsconfig.json   # typecheck the server

# Run a single test file or test by name:
npx vitest run src/__tests__/incomeTax.test.ts
npx vitest run -t "higher-rate income spans two bands"
```

There is no linter configured; `tsc --noEmit` is the type gate. Tests live in `src/__tests__/`.

## What this is

A **local-first** SPA (React + TS + Vite) plus a small local persistence API, growing into a small
household-finance suite. `src/ui/App.tsx` is a thin shell with a top-level **module switcher**;
there are currently two modules (pre-retirement forecasting is planned as a third):

1. **Retirement forecast** (`src/ui/RetirementApp.tsx` and most of `src/`) — models a UK couple's
   retirement drawdown. It reproduces the original `NewForecast.xlsx` (kept in the repo root and
   used as the golden reference for tests), fills in a full UK tax calculation, and proposes a
   tax-aware buy/sell strategy. All state is a plain-data `Scenario` object.
2. **Monthly expenses** (`src/ui/expenses/`, see "Monthly expense tracker" below) — reproduces
   `Expenditure2026.xlsx` (also in the repo root, golden reference for its tests): tracks the joint
   current account month by month so it never drops below zero.

Everything is persisted to a local SQL Server database (see "Persistence" below); the browser's
`localStorage` is only a cache/offline fallback. The only network I/O is the app ↔ local API on
127.0.0.1. The `.xlsx` files are data references only — never build inputs.

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

## Monthly expense tracker

A separate, **global** feature (deliberately *not* per-scenario: it records actuals about the real
joint account, so scenario duplicate/delete must never fork or destroy it). Same layering as the
forecast:

- **Model** `src/model/expenseTypes.ts`: `ExpenseData = { templates, months }`. Templates are the
  editable standard lists (expenses with a due day-of-month + default amount; income sources with a
  default amount). Each `ExpenseMonth` (key `"yyyy-mm"`) is a **snapshot** of the templates taken
  when the month is created — its lines are then overridden/added/removed freely without touching
  the standard list or other months. Per expense line: `amount` (expected) and `paid` (actual so
  far). Per month: `startBalance` and a nullable `currentBalance` (the balance at the bank "now").
  `migrateExpenseData` in `src/model/migrate.ts` backfills old saves.
- **Calc** `src/expenses/calc.ts` (pure): `summariseMonth` reproduces the spreadsheet's numbers —
  totals for Amount/Paid/To Pay, `totalAvailable` (start balance + income, the sheet's income-side
  SUM), `headroom` = expected end balance (the sheet's "Balance To Reach 0") and `predicted`
  (= currentBalance − still-to-pay). `monthWarnings` flags months heading below zero. Golden tests
  in `src/__tests__/expenseCalc.test.ts` use January/March 2026 numbers from `Expenditure2026.xlsx`.
- **Store** `src/store/expenseStore.ts`: mirrors `scenarioStore` (localStorage cache
  `retirement-forecast:expenses`, debounced 400ms write-through per month + for the template set,
  `pagehide` flush, empty-DB seeding, own `dbStatus`).
- **Persistence**: tables `ExpenseTemplate`, `ExpenseMonth`, `ExpenseMonthItem` (cascade) in
  `server/db.ts`; pure mapping `server/expenseMapping.ts` guarded by
  `src/__tests__/expenseMapping.test.ts` (round-trip + key coverage — extend both when adding a
  field); repo `server/expenseRepo.ts`; routes `GET /api/expenses`, `PUT /api/expenses/templates`,
  `PUT/DELETE /api/expenses/months/:key`. The backup envelope has an optional `expenses` field —
  old backups without it leave the tracker untouched on import.

## Persistence (SQL Server + local API)

- **The database is the source of truth.** `server/` is an Express API (`npm run server`, port
  5174; Vite proxies `/api` there) that owns a local SQL Server database `RetirementForecast`.
  `server/db.ts` bootstraps the database and tables idempotently on first use. Credentials come
  from `containerSecrets/sql-creds.json` (gitignored); they are read only by the server process,
  never the frontend.
- **Connection is shared-memory, not TCP.** The local SQL Server instance has TCP/IP disabled, so
  the server uses `mssql/msnodesqlv8` (ODBC Driver 18) with an explicit `connectionString` —
  the pure-JS tedious driver cannot connect. Windows-only by construction. Note the @types/mssql
  typings put `connectionString` under `options`, but the runtime reads it top-level (see
  `poolConfig` in `server/db.ts`).
- **Normalized schema, one row-mapping module.** Tables: `Scenario` (scalars incl. rates/income/
  strategy/finalIncome date + `sortOrder` for list order), `ScenarioPerson` (person + balances +
  final income per person), `ScenarioTaxYearParams`, `ScenarioOverride`, `ScenarioPurchase`
  (child tables, `ON DELETE CASCADE`), `AppState` (singleton active-scenario pointer).
  `server/mapping.ts` is the **pure** row↔Scenario mapping; every user-editable field must appear
  there once in each direction, guarded by `src/__tests__/sqlMapping.test.ts` (round-trip + key
  coverage). When adding a Scenario field: extend the schema DDL, `mapping.ts`, and that test.
- **Store behaviour** (`src/store/scenarioStore.ts`): loads from `GET /api/state` on startup;
  mutations write through to the API (debounced 400ms per scenario for keystroke edits, immediate
  for add/delete/duplicate/active, flushed with `keepalive` on `pagehide`). localStorage is a
  cache/offline fallback — if the API is down the UI shows a "DB offline" chip and keeps working
  locally. On startup with an **empty** database, localStorage scenarios are migrated up (this is
  the upgrade path for pre-SQL installs — don't leave test data in the DB, it would shadow a
  user's browser data).
- **JSON import/export = database backup/restore.** `GET /api/export` returns a versioned
  envelope (`format: "retirement-forecast-backup"`, `scenarios[]`, `activeId`); `POST /api/import`
  replaces the whole database atomically. The UI's Import button also accepts legacy
  single-scenario JSON files and adds them as a new scenario. Version-migration for old files
  lives in `src/model/migrate.ts` (shared by store and server — extend it when adding fields).

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
