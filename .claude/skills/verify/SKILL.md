---
name: verify
description: Build, launch and drive the retirement-forecast app (Vite SPA + local SQL Server persistence API) to verify changes end-to-end.
---

# Verifying retirement-forecast

## Launch

```bash
npm run dev    # concurrently: API (tsx server/index.ts, http://127.0.0.1:5174) + Vite (http://localhost:5173)
```

Wait for both lines: `Forecast API listening on http://127.0.0.1:5174` and Vite's
`Local: http://localhost:5173/`. The API creates the `RetirementForecast` SQL Server
database and tables on first use (credentials: `containerSecrets/sql-creds.json`).
Health check through the proxy: `curl http://localhost:5173/api/health`.

**Gotcha (agent background shells):** killing the background `npm run dev` task orphans
the node children on Windows — afterwards kill leftovers and free ports 5173/5174:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*vite*" -or $_.CommandLine -like "*server/index.ts*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Also: don't use `npm:script` nesting inside `concurrently` on this machine — the npm
shim exits while its child lives on and `-k` then tears down the other process
(that's why package.json calls `tsx server/index.ts` directly).

## Drive

- UI via Playwright MCP at `http://localhost:5173`. The DB status chip in the scenario
  bar reads `● SQL Server` / `○ DB offline` — assert it after load.
- Keystroke edits persist debounced (~400ms); `Start-Sleep 2` before checking SQL.
- Inspect the database directly (shared-memory connection, so plain sqlcmd works):

```powershell
sqlcmd -S localhost -U sa -P <password-from-containerSecrets> -C -d RetirementForecast `
  -Q "SELECT id, name, sortOrder FROM dbo.Scenario; SELECT activeScenarioId FROM dbo.AppState" -W
```

- Offline path: run `npx vite` alone (API down) → app loads from localStorage cache,
  chip shows `○ DB offline`.
- Import JSON: Playwright file uploads must come from inside the repo (e.g. `.playwright-mcp/`).
  A backup-format file triggers a `confirm()` dialog — handle it with browser_handle_dialog.

## Flows worth driving

1. Load app → chip `● SQL Server` → edit an input → row updated in SQL.
2. Reload after `localStorage.clear()` → data comes back from SQL (proves DB is source of truth).
3. Export JSON → download is a `retirement-forecast-backup` envelope with all scenarios.
4. Import that file → confirm dialog → DB replaced.
5. Add/duplicate/delete scenario → `dbo.Scenario` rows and `AppState` pointer follow; no orphan child rows.

## Leave it clean

If you created test scenarios against the real DB, delete them (or
`DELETE FROM dbo.AppState; DELETE FROM dbo.Scenario;` for a full wipe). An empty DB is
safe: the app re-seeds it from the user's browser storage on next load. A DB left full
of test scenarios will **shadow the user's real browser data** — never leave that state.
