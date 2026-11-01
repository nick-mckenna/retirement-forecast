# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # API server (127.0.0.1:5174) + Vite dev server (localhost:5173) via concurrently
npm run server       # persistence API server only (tsx server/index.ts)
npm run build        # tsc -b, tsc -p server/tsconfig.json, then vite build -> dist/
npm run preview      # API server + vite preview (serves the dist/ build)
npm test             # vitest run (all tests once)
npm run test:watch   # vitest watch mode
npx tsc --noEmit     # typecheck the app (strict mode; noUnusedLocals/Parameters on)
npx tsc -p server/tsconfig.json   # typecheck the server

# Run a single test file or test by name:
npx vitest run src/__tests__/incomeTax.test.ts
npx vitest run -t "higher-rate income spans two bands"
```

There is no linter configured; `tsc --noEmit` is the type gate. Tests live in `src/__tests__/`.

`dev`/`preview` call `tsx server/index.ts` directly inside `concurrently` rather than
`npm run server` — on this Windows machine a nested npm shim exits while its child lives on, and
`concurrently -k` then tears down the other process. Stopping a backgrounded `npm run dev` also
orphans its node children (ports 5173/5174 stay bound). The project's `/verify` skill
(`.claude/skills/verify/SKILL.md`) has the cleanup command and the end-to-end procedure: DB status
chip, `sqlcmd` checks against the tables, and leaving the database clean afterwards.

## What this is

A **local-first** SPA (React + TS + Vite) plus a small local persistence API — a small
household-finance suite. `src/ui/App.tsx` is a thin shell with a top-level **module switcher**
over three modules:

1. **Retirement forecast** (`src/ui/RetirementApp.tsx` and most of `src/`) — models a UK couple's
   retirement drawdown. It reproduces the mechanics of an original `NewForecast.xlsx` spreadsheet,
   fills in a full UK tax calculation, and proposes a tax-aware buy/sell strategy. All state is a
   plain-data `Scenario` object.
2. **Pre-retirement forecast** (`src/ui/preretirement/`, see "Pre-retirement forecast" below) —
   the accumulation phase: projects the couple's real investment accounts month by month from
   today to the retirement start date, fed by contribution lines tagged in the expense tracker,
   and hands its ending balances to a linked retirement scenario.
3. **Monthly expenses** (`src/ui/expenses/`, see "Monthly expense tracker" below) — reproduces
   `Expenditure2026.xlsx`, the household's expenditure spreadsheet: tracks the joint current
   account month by month so it never drops below zero.

Everything is persisted to a local SQL Server database (see "Persistence" below); the browser's
`localStorage` is only a cache/offline fallback. The only network I/O is the app ↔ local API on
127.0.0.1. The `.xlsx` files are **gitignored personal data** — they may sit in the working copy
as references but are never committed, never build/test inputs, and a fresh clone won't have them.
All committed tests and defaults use synthetic figures only (see "Never commit sensitive data"
under Conventions).

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
  (`src/strategy/optimiser.ts`) inside a single `useMemo` in `src/ui/RetirementApp.tsx`
  (on the scenario resolved by `resolveScenarioForRun`, see "Handoff" below). `runForecast` calls
  `simulate` once for `heuristic`/`annual` tax modes; for `lifetime` mode it fully simulates ~12
  whole-plan candidates (the rules-based plan, the annual optimiser, and annual-mode sales plus
  crystallisation filled to 0–100% of the basic band, refined ±0.05/±0.1 around the best) and
  returns the lowest-total-tax one (`RetirementApp` defers it with `useDeferredValue`). Keep the
  engine pure and side-effect free.
- **`strategy.taxMode` selects how investments are sold**: `heuristic` (fixed priority list; its
  band tops are net of the year's savings and dividends and stop at the £100k taper), `annual`
  (`raiseCashMarginal`: exact-cost segment greedy that minimises that year's tax — every candidate
  sale is priced with `personYearTax` in chunks up to the next kink in the rates, ties going to the
  allowances that expire this year (pension, then GIA) before the ISA; deliberately myopic, so it
  spends the tax-free ISA before 20% pension), `lifetime` (searches how far to crystallise pension
  each year to minimise total tax). Proactive crystallisation — lifetime fill, or the heuristic's
  `fillPersonalAllowanceFromPension` (up to the PA) — happens at year end *before* the refill, with the
  year's savings and dividends counted towards the ceiling; the proceeds go to cash, one refill
  provisions all the tax, and crystallised cash the buffer doesn't need is sheltered in the ISA (up
  to the allowance) then the GIA at cost. See `src/strategy/drawdown.ts` and `optimiser.ts`.
- **Income target**: `income.mode` is `fixed` (`baseAnnual`) or `swr` (`swrRate` × starting
  ISA + pension + GIA). `resolveIncome` (`src/model/incomeTargets.ts`) turns either into a
  `baseAnnual` that is then inflated yearly; the engine, Excel export and UI only ever see the
  resolved figure, so route new income logic through it. `Scenario.purchases` are one-off cash
  needs (house, car) funded in their month by the same tax-efficient sell path as the year-end
  refill (`applyPlanned`/`fundCash` in `simulate.ts`), so their tax lands in that year.
- **The engine is a monthly ledger with an annual tax boundary.** The model starts the **day after
  `startDate`** (the "Starting Balances" date); `income.startYear` is derived from that
  (`firstModelledTaxYear`, kept in sync by the UI and migration), so a mid-year start gives a part
  first year. For each UK tax year (6 Apr → 5 Apr) it: does annual start events (gilt maturities →
  cash, gilt coupons, Bed & ISA fill), runs the monthly steps (investment growth at the monthly S&S
  rate, savings interest, state pension, the one-off final salary in its month, draw the monthly
  income need — own cash, spouse's cash, then gilts sold at par), then at year end runs the
  **buffer refill** (sell investments), **gilt ladder** purchases, and finally computes income tax +
  CGT and settles it from cash. The final salary is earnings of its tax year: its gross counts
  towards that year's income and the PAYE entered with it is credited (`PersonTax.paidAtSource`), so
  the year end settles only `due = total − paidAtSource` (negative = refund). GIA gains always come
  from the tracked cost basis (`giaBasis`, which reinvested dividends raise); sale plans see the live
  gain fraction, the CGT exempt amount the year has left, and pension access on the sale date. Every
  emitted `LedgerRow` is either a `BALANCE` snapshot or a `TRANSACTION` delta, mirroring the
  original spreadsheet's alternating structure, and each delta is booked to the pot and person that
  actually moved — `engineTimeline.test.ts` reconciles every balance row against the deltas.
- **The refill provisions for the year's tax.** Tax is paid out of cash right after the refill, so
  `refillAmount` sizes the sale to the fixed point T = target − buffer + tax(after selling T) — the
  buffer lands on target *after* tax (lifetime mode re-runs it after crystallisation). Without this
  the buffer ends every year short by the tax bill and cash can run out before the next refill.
  `assessTax` is the one pure tax calculation used both for that estimate and for the real bill;
  `src/__tests__/refill.test.ts` pins the buffer-at-target invariant in all three tax modes.
  Cash is treated as joint for paying out (as the monthly draw already is): `payTax` takes each
  person's tax from their own cash then their spouse's, and `planGiltPurchases` splits a rung by
  each person's spare cash after their tax — so neither person is overdrawn while the couple
  has cash (also pinned in `refill.test.ts`).
- **Strategy is separated from the engine** (`src/strategy/`): `buffer.ts` (target = the next N —
  possibly fractional — years of the income *need net of State Pension*, as cash + gilts; the engine
  passes that need as a `NeedFn`), `drawdown.ts` (the tax-efficient *sell order* — a priority list of
  extraction steps per person; this is where "which investment to sell" lives), `giltLadder.ts`
  (liability-matched, self-repairing ladder: next year is cash plus gilts maturing on its 6 April;
  each later window year, up to `giltLadderYears` ahead, gets whatever it is still short, nearest
  first; opening gilts are spread across the first rung years by `initState`). The engine calls
  these; they return plans, the engine applies them. Keep that boundary.
- **Tax is its own layer** (`src/tax/`): `incomeTax.ts` implements the real UK ordering
  (non-savings → savings → dividends, with PA taper, savings starting-rate band + PSA, dividend
  allowance; savings income has its own rates, which diverge from 2027/28); `cgt.ts` (gilts are
  intentionally CGT-exempt and must never be passed to it); `personTax.ts` (`personYearTax` — income
  tax + CGT for a person-year, the one calculation the engine's `assessTax` uses; CGT's lower-rate
  band is `basicRateBand − taxableTotal`, since `taxableTotal` is already after the PA);
  `statePension.ts`; `taxParams.ts` holds the per-year parameters: a 2025/26 baseline plus a
  `BASELINE_SCHEDULE` of announced changes (each with its source), frozen to
  `taxPolicy.freezeUntilYear` and then moved by `taxPolicy.indexation` via
  `projectTaxParams(year, policy, inflation)`. `DEFAULT_TAX_POLICY` is **frozen to 2030/31, then
  statutory** — the PA and basic band rise with `rates.inflation`, while the £125,140
  additional-rate threshold, the £100k taper and other allowances stay fixed ("custom" uprates all
  allowances by `uprating`). `TAX_PARAM_FIELDS` is the canonical field list (editor, mapping,
  migration). User edits are **sparse**: `Scenario.taxParams` stores only edited fields per year
  (NULL columns in SQL) and `resolveTaxParams` lays them over the projection. The State Pension is
  uprated separately and is unaffected. One-off shape changes in `migrate.ts` are gated on
  `Scenario.schemaVersion` (`SCHEMA_VERSION` in `defaults.ts`) so each runs once; v1 → v2 turned the
  old `{2031, 0%}` default into statutory and reduced stored rows to their genuinely edited fields.
- **Person-level allowances.** Pension draws are 25% tax-free only while the **Lump Sum Allowance**
  lasts (£268,275, `src/tax/pensionDraw.ts`; `Person.lumpSumAllowanceUsed` records tax-free cash
  already taken, `AccountState.lsaRemaining` tracks the rest): every place that turns a pension draw
  into taxable income goes through `pensionTaxable` / `pensionGrossForTaxable` and records
  `Withdrawal.lsaUsed` — never a hard-coded 0.75. **State Pension age** is statutory from the date of
  birth (`statutoryStatePensionDate`, the legislated 66 → 67 → 68 tables) unless
  `Person.statePensionAge` overrides it (fractional years allowed); it is paid monthly from that date
  and uprated by `rates.statePensionGrowth`, or the triple-lock floor `max(inflation, 2.5%)` when
  null. **Marriage allowance** (`Scenario.married`, `coupleYearTax`) is applied when both partners are
  within the basic rate and it saves tax.
- **Premium Bonds** are their own pot (`StartingBalances.premiumBonds`, `AccountState.premiumBonds`,
  prize rate `Rates.premiumBondRate`): cash-like and part of the buffer, but their prizes are tax-free
  (never savings income) and are reinvested up to the £50,000 limit, paid out as cash beyond it.
  They are shown inside the ledger's cash (savings) column, so the Excel column letters don't move;
  draws, purchases and tax take plain cash first, then Premium Bonds (`takeCash`), then gilts.
- **Deferred pension tax** (display only): each `YearSummary` reports the income tax still to come on
  the pensions left at year end, priced as drawn evenly over ten years on top of the State Pension
  after any Lump Sum Allowance left, and `netWorthAfterPensionTax` (KPI, TaxView, Excel Tax Summary).
  The optimiser objective doesn't use it; inheritance tax on pensions (from April 2027) isn't modelled.

## Pre-retirement forecast

The accumulation-phase module linking all three feature sets. Same layering as the others (pure
engine → zustand store → SQL tables), and **global** like the expense tracker (facts about the
real accounts — scenario duplicate/delete must never fork or destroy it).

- **Accounts are a user-editable registry of real accounts**
  (`src/model/preRetirementTypes.ts`): `InvestmentAccount { id, name, owner, kind,
  openingBalance, openingGainFraction }`, e.g. "Nick ISA", "Tracy Pension".
  The `kind` (`PreAccountKind`: isa | pension | gia | savings |
  **premiumBonds** | gilts) is the grouping vocabulary shared by all three modules — it picks the
  growth rate and the retirement pot at handoff. `defaultPreRetirementData()` ships a generic
  sample registry (one account per person × kind, zero balances; `defaultExpenseData` likewise
  ships a generic standing-order list) — the user renames/extends it to match their real
  accounts, which live only in the local DB. `emptyPreRetirementData()` is what the server
  reports before anything is saved. Expense/income lines are tagged with an account's `id`.
  `PreRetirementData = { openingMonth, accounts, overrides }`: opening balances are as of the
  START of `openingMonth`; a `BalanceOverride { accountId, monthKey, day, value }` records the
  **actual** balance at the end of `day` in that month (`day` null = end of the month) and
  re-anchors the projection there — the rest of the month's growth is pro-rated by calendar days
  and contributions due after the recorded day are still added (this — not the expense tracker's
  Paid column — is how real growth, including losses, is fed in). A month may hold several
  records (the DB key is a surrogate id); the latest-day one anchors, earlier ones are history. Deleting an account
  keeps its tags on expense lines (shown as "(deleted account)", excluded from the forecast with
  a warning) — deliberately no FK from the expense tables, so history is never broken.
- **Engine** `src/preretirement/project.ts` (pure, like `simulate`): `projectAccounts(data,
  expenseMonths, rates, endMonth)` walks each account monthly — growth first
  (`annualToMonthly`), then tagged flows (expense line = contribution IN, income line =
  withdrawal OUT, always the expected `amount`, never `paid`), then any override. Growth rates
  come from the active scenario's `Rates` via `ratesForKinds` (isa/pension/gia →
  `investmentGrowth`, savings/premiumBonds → `savingsInterest`, gilts → `giltCoupon`). It tracks
  each person's GIA cost basis for the CGT handoff and reports `missingMonthKeys` /
  `unknownAccountIds` as warnings. `balancesAtDate` samples the end of any day (clamped to the
  range, re-anchored at recorded balances up to that day) for the Snapshot tab.
- **Handoff** `src/preretirement/link.ts`: the projection runs through `startDate`'s month and is
  sampled at the **end of `startDate`** (`sampleAtDate` → balances + GIA basis); the engine owns
  everything from the next day, which is the no-double-counting rule (`handoffMonthKey` returns the
  month the projection must reach; null for an invalid date). `Scenario.linkPreRetirement` (toggle in
  InputsPanel) makes `resolveScenarioForRun` replace the scenario's starting balances with the
  projection (premiumBonds keep their own pot; gilts flow; `giaGainFraction`
  computed from the tracked basis) before `RetirementApp` calls `runForecast` — the engine is
  never modified. Falls back to manual balances (with a warning) when the projection can't cover
  the handoff month.
- **Store** `src/store/preRetirementStore.ts`: mirrors the others (localStorage cache
  `retirement-forecast:preretirement`, single 400ms debounced whole-document save, `pagehide`
  flush, empty-DB seeding — seeding treats an all-zero document as unsaved).
- **Persistence**: tables `PreRetirementState` (singleton), `PreRetirementPot`,
  `PreRetirementOverride` in `server/db.ts`; pure `server/preRetirementMapping.ts` guarded by
  `src/__tests__/preRetirementMapping.test.ts`; repo `server/preRetirementRepo.ts`; routes
  `GET/PUT /api/preretirement` (whole-document). The backup envelope has an optional
  `preRetirement` field — old backups leave the module untouched. Engine tests live in
  `src/__tests__/preRetirementProject.test.ts`.
- The expense store's `addMonthsUntil(untilKey)` bulk-creates months to the retirement handoff
  (chaining start balances); the module's warn-banner offers it when months are missing.

## Monthly expense tracker

A separate, **global** feature (deliberately *not* per-scenario: it records actuals about the real
joint account, so scenario duplicate/delete must never fork or destroy it). Same layering as the
forecast:

- **Model** `src/model/expenseTypes.ts`: `ExpenseData = { templates, months }`. Templates are the
  editable standard lists (expenses with a due day-of-month + default amount; income sources with a
  default amount). Each `ExpenseMonth` (key `"yyyy-mm"`) is a **snapshot** of the templates taken
  when the month is created — its lines are then overridden/added/removed freely without touching
  the standard list or other months. The one route back the other way is the Standard items tab's
  "Update future months" button (`applyTemplatesToFuture`), which re-snapshots the templates into
  every month **after** the current calendar month and re-chains their start balances; the current
  and past months are the record of what actually happened and are never rewritten. Per expense
  line: `amount` (expected) and `paid` (actual so far). Per month: `startBalance` and a nullable `currentBalance` (the balance at the bank "now").
  Every template and month line also carries a nullable `accountId` tagging it to one of the
  shared investment accounts (see "Pre-retirement forecast") — expense = contribution into it,
  income = withdrawal from it. `migrateExpenseData` in `src/model/migrate.ts` backfills old saves.
- **Calc** `src/expenses/calc.ts` (pure): `summariseMonth` reproduces the spreadsheet's numbers —
  totals for Amount/Paid/To Pay, `totalAvailable` (start balance + income, the sheet's income-side
  SUM), `headroom` = expected end balance (the sheet's "Balance To Reach 0") and `predicted`
  (= currentBalance − still-to-pay). `monthWarnings` flags months heading below zero.
  `createMonthFromTemplates` snapshots the standard items into a new month; `futureMonths(d,
  todayKey)`, `applyTemplatesToMonth` and `applyTemplatesToFutureMonths(d, todayKey)` are the
  push-to-future-months path (template lines in template order, orphans dropped, one-offs kept,
  `paid` clamped to the new amount, start balances re-chained). Like every helper here they take
  `todayKey` as a parameter rather than reading the clock — that is what keeps them testable.
  Tests in `src/__tests__/expenseCalc.test.ts` pin these formulas (which mirror the spreadsheet's)
  with synthetic sample months.
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
  5174; Vite proxies `/api` there) that owns a local SQL Server database — `RetirementForecast`
  by default, overridable via the `RETIREMENT_DB_NAME` env var. Vitest pins
  `RETIREMENT_DB_NAME=RetirementForecastTest` (see `vite.config.ts`), so any test that touches
  the database bootstraps and uses the test database, never the production one.
  `server/db.ts` bootstraps the database and tables idempotently on first use. Credentials come
  from `containerSecrets/sql-creds.json` (gitignored; copy `sql-creds.json.example` to create it);
  they are read only by the server process, never the frontend.
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
- **`scripts/backup-db.sh`** (Git Bash) exports the whole production database as a timestamped
  `.bacpac` to the Google Drive financial vault via `sqlpackage` over shared memory
  (`lpc:localhost`).
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
- **Overrides**: a `Scenario.overrides` entry keyed `year:person:source` (e.g. `2030:nick:pension`)
  is a fixed year-end refill sale: clamped to the pot (with a warning), charged to the plans via
  `planWithdrawal`, and the automatic plan raises the rest from the other pots inside the refill's
  fixed point (`refillSales` in `simulate.ts`), so its tax is provisioned. Malformed or out-of-range
  keys warn; migration rewrites the old `year:refill:person:source[:n]` form. No UI writes them yet.
- **Golden tests** (`src/__tests__/golden.test.ts`) pin the engine's monthly growth/draw mechanics
  to hand-computed illustrative figures (e.g. an ISA at the default rates: 200,000 → 201,130.83 in
  one month) and smoke-test a full `simulate(defaultScenario())` run (year count, first-year income
  target, buffer, gilt rungs). If you change growth/income mechanics, expect these to move and
  update them deliberately, not casually.
- **Never commit sensitive data.** Real balances, payees, employers, providers, and credentials
  belong only in the local database and the gitignored files (`*.xlsx`,
  `containerSecrets/sql-creds.json`) — never in anything committed to git: source, defaults, test
  fixtures, docs, or commit messages. Everything committed is synthetic: `defaultScenario()` is a
  "Sample couple" (Person A/B), `defaultExpenseData()`/`defaultPreRetirementData()` ship generic
  items with illustrative amounts, and all test fixtures use made-up figures. When adding tests or
  defaults, invent numbers — do not transcribe them from the spreadsheets or the database.
- The Excel builder is split into a pure `buildWorkbook()` (DOM-free, unit-tested via round-trip) and a
  thin `exportToExcel()` download wrapper — add new sheet logic in `buildWorkbook`. The
  Pre-retirement Snapshot PDF (`src/export/snapshotPdf.ts`, jsPDF + autotable) follows the same
  split (`buildSnapshotPdf` / `exportSnapshotPdf`), and its numbers come from
  `buildSnapshotSummary` (`src/export/snapshotSummary.ts`), the one pure source that both the
  on-screen `SnapshotView` and the PDF render from — change figures there, not in either view.
- `PersonId` is the fixed pair `"nick" | "tracy"`: internal keys used throughout the model, the SQL
  rows and the server's validation (account `owner`). Display names come from `Person.name`
  ("Person A/B" in the defaults). Never rename the keys or add a third person casually.

## Disclaimer baked into the product

Default tax figures are best-known values and future-year thresholds are assumptions; the app presents
itself as a planning aid, not tax advice, and every threshold is user-editable in the Tax Parameters
tab. Preserve that framing when touching the tax layer or UI copy.
