# Retirement Forecast

A local-first web app that models a UK couple's retirement drawdown — reproducing a
spreadsheet forecast from configurable inputs, adding a full UK tax engine, and
proposing a tax-aware buy/sell strategy to hit income targets while minimising tax.

Default inputs are illustrative sample figures only; enter your own — data stays in your browser.

**Your financial data never leaves your browser.** Scenarios are saved in `localStorage`
and can be exported/imported as JSON files. There is no server and no account.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build to dist/
npm test           # unit + golden + excel round-trip tests
```

## What it does

- **Reproduces the spreadsheet.** A monthly ledger (Transactions view) with the same
  columns: per-person Income / ISA / Pension / GIA / Savings, gilts, per-person Tax,
  the "Savings & Gilts" 3-year buffer, and Net Worth. Starting balances, monthly growth,
  income draws and the April ISA fill match `NewForecast.xlsx`.
- **Full UK tax engine** (`src/tax/`) fills the previously-empty tax columns: income tax
  with personal allowance + taper, savings starting-rate band & personal savings
  allowance, dividend allowance, pension drawdown (25% tax-free), CGT on GIA disposals
  (**gilts are CGT-exempt**), and state pension. Every threshold is editable per tax year.
- **Tax-aware strategy** (`src/strategy/`): keeps ~3 years of income as cash + a rolling
  gilt ladder, and each year raises cash by selling in a tax-efficient order — filling
  each spouse's personal allowance from pension, using the CGT annual exempt amount,
  preserving the ISA wrapper, and spreading income across both people's allowances.
  Person A's pension is locked until age 57 (April 2032); Person B's is available from the start.
- **Scenarios**: duplicate, compare, edit any input, and export a matching `.xlsx`
  (Interest Rates / Income Targets / Transactions / Tax Summary) with live formulas.

## Layout

```
src/model/      types, rates, income targets, default scenario
src/tax/        tax-year helpers, editable params, income tax, CGT, state pension
src/engine/     ledger types, simulation state, the monthly simulation engine
src/strategy/   3-year buffer, tax-efficient drawdown order, gilt ladder
src/store/      Zustand scenario store (localStorage + JSON import/export)
src/ui/         React UI: inputs, charts, ledger, tax view, tax-params editor
src/export/     ExcelJS workbook builder matching the original layout
src/__tests__/  Vitest tests incl. golden checks against NewForecast.xlsx numbers
```

## Disclaimer

This is a planning aid, **not tax or financial advice**. Default tax figures are
best-known England & Wales values (frozen to 2028, then uprated with inflation) and
future-year thresholds are assumptions — verify against HMRC and adjust in the Tax
Parameters tab.
