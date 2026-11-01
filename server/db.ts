// SQL Server connection + schema bootstrap.
//
// Connects to the local default instance over shared memory via the
// msnodesqlv8 ODBC driver (the instance does not have TCP/IP enabled, so the
// pure-JS tedious driver cannot reach it). Credentials are read at runtime
// from containerSecrets/sql-creds.json and never leave the server process.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql/msnodesqlv8";

export { sql };

/** Production data lives in the default; tests must never touch it, so vitest
 *  pins RETIREMENT_DB_NAME=RetirementForecastTest (see vite.config.ts). */
export const DB_NAME = process.env.RETIREMENT_DB_NAME || "RetirementForecast";

const here = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = resolve(here, "..", "containerSecrets", "sql-creds.json");

/** @types/mssql omits the top-level `connectionString` the msnodesqlv8 pool
 *  actually reads (its typings put it under `options`, which the runtime
 *  ignores), hence the widened type. */
function poolConfig(database: string): sql.config {
  const cfg = { server: "localhost", connectionString: connectionString(database) };
  return cfg as sql.config & typeof cfg;
}

function connectionString(database: string): string {
  const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8")) as {
    username: string;
    password: string;
  };
  // Braces make the values safe if they ever contain ';' (a '}' must double).
  const esc = (v: string) => `{${v.replace(/}/g, "}}")}}`;
  return [
    "Driver={ODBC Driver 18 for SQL Server}",
    "Server=localhost",
    `Database=${database}`,
    `UID=${esc(creds.username)}`,
    `PWD=${esc(creds.password)}`,
    "TrustServerCertificate=yes",
    "Encrypt=no",
  ].join(";");
}

/** The ScenarioTaxYearParams value columns as first shipped (NOT NULL then), listed here
 *  rather than derived so the upgrade guards stay a fixed historical record. */
const LEGACY_TAX_PARAM_COLUMNS = [
  "personalAllowance",
  "paTaperThreshold",
  "basicRateBand",
  "higherRateBand",
  "basicRate",
  "higherRate",
  "additionalRate",
  "psaBasic",
  "psaHigher",
  "savingsStartingRateBand",
  "dividendAllowance",
  "dividendBasicRate",
  "dividendHigherRate",
  "dividendAdditionalRate",
  "cgtAnnualExempt",
  "cgtBasicRate",
  "cgtHigherRate",
  "isaAllowance",
];

/** One statement per entry; each is idempotent so bootstrap can run every start. */
const SCHEMA: string[] = [
  `IF OBJECT_ID(N'dbo.Scenario', N'U') IS NULL
   CREATE TABLE dbo.Scenario (
     id NVARCHAR(64) NOT NULL CONSTRAINT PK_Scenario PRIMARY KEY,
     name NVARCHAR(200) NOT NULL,
     startDate DATE NOT NULL,
     investmentGrowth FLOAT NOT NULL,
     savingsInterest FLOAT NOT NULL,
     inflation FLOAT NOT NULL,
     giltCoupon FLOAT NOT NULL,
     giaDividendYield FLOAT NOT NULL,
     incomeMode NVARCHAR(10) NOT NULL,
     incomeBaseAnnual FLOAT NOT NULL,
     incomeSwrRate FLOAT NOT NULL,
     incomeStartYear INT NOT NULL,
     incomeYears INT NOT NULL,
     incomeGrowth FLOAT NOT NULL,
     bufferYears FLOAT NOT NULL,
     autoStrategy BIT NOT NULL,
     fillPersonalAllowanceFromPension BIT NOT NULL,
     preserveIsa BIT NOT NULL,
     giltLadderYears INT NOT NULL,
     taxMode NVARCHAR(10) NOT NULL,
     lifetimeFillFraction FLOAT NULL,
     finalIncomeDate DATE NOT NULL,
     taxFreezeUntilYear INT NOT NULL CONSTRAINT DF_Scenario_taxFreezeUntilYear DEFAULT 2031,
     taxIndexation NVARCHAR(10) NOT NULL CONSTRAINT DF_Scenario_taxIndexation DEFAULT N'custom',
     taxUprating FLOAT NOT NULL CONSTRAINT DF_Scenario_taxUprating DEFAULT 0,
     schemaVersion INT NOT NULL CONSTRAINT DF_Scenario_schemaVersion DEFAULT 1,
     linkPreRetirement BIT NOT NULL CONSTRAINT DF_Scenario_linkPreRetirement DEFAULT 0,
     sortOrder INT NOT NULL CONSTRAINT DF_Scenario_sortOrder DEFAULT 0,
     updatedAt DATETIME2 NOT NULL CONSTRAINT DF_Scenario_updatedAt DEFAULT SYSUTCDATETIME()
   )`,
  `IF OBJECT_ID(N'dbo.ScenarioPerson', N'U') IS NULL
   CREATE TABLE dbo.ScenarioPerson (
     scenarioId NVARCHAR(64) NOT NULL
       CONSTRAINT FK_ScenarioPerson_Scenario REFERENCES dbo.Scenario(id) ON DELETE CASCADE,
     personId NVARCHAR(10) NOT NULL,
     name NVARCHAR(100) NOT NULL,
     dob DATE NOT NULL,
     pensionAccessAge INT NOT NULL,
     statePensionAge INT NOT NULL,
     statePensionAnnual FLOAT NOT NULL,
     isa FLOAT NOT NULL,
     pension FLOAT NOT NULL,
     gia FLOAT NOT NULL,
     savings FLOAT NOT NULL,
     gilts FLOAT NOT NULL,
     giaGainFraction FLOAT NOT NULL,
     finalIncomeNet FLOAT NOT NULL,
     finalIncomeTax FLOAT NOT NULL,
     CONSTRAINT PK_ScenarioPerson PRIMARY KEY (scenarioId, personId)
   )`,
  `IF OBJECT_ID(N'dbo.ScenarioTaxYearParams', N'U') IS NULL
   CREATE TABLE dbo.ScenarioTaxYearParams (
     scenarioId NVARCHAR(64) NOT NULL
       CONSTRAINT FK_ScenarioTaxYearParams_Scenario REFERENCES dbo.Scenario(id) ON DELETE CASCADE,
     year INT NOT NULL,
     -- One column per parameter; NULL = not edited for this year (follows the projection).
     personalAllowance FLOAT NULL,
     paTaperThreshold FLOAT NULL,
     basicRateBand FLOAT NULL,
     higherRateBand FLOAT NULL,
     basicRate FLOAT NULL,
     higherRate FLOAT NULL,
     additionalRate FLOAT NULL,
     psaBasic FLOAT NULL,
     psaHigher FLOAT NULL,
     savingsStartingRateBand FLOAT NULL,
     savingsBasicRate FLOAT NULL,
     savingsHigherRate FLOAT NULL,
     savingsAdditionalRate FLOAT NULL,
     dividendAllowance FLOAT NULL,
     dividendBasicRate FLOAT NULL,
     dividendHigherRate FLOAT NULL,
     dividendAdditionalRate FLOAT NULL,
     cgtAnnualExempt FLOAT NULL,
     cgtBasicRate FLOAT NULL,
     cgtHigherRate FLOAT NULL,
     isaAllowance FLOAT NULL,
     CONSTRAINT PK_ScenarioTaxYearParams PRIMARY KEY (scenarioId, year)
   )`,
  `IF OBJECT_ID(N'dbo.ScenarioOverride', N'U') IS NULL
   CREATE TABLE dbo.ScenarioOverride (
     scenarioId NVARCHAR(64) NOT NULL
       CONSTRAINT FK_ScenarioOverride_Scenario REFERENCES dbo.Scenario(id) ON DELETE CASCADE,
     overrideKey NVARCHAR(200) NOT NULL,
     amount FLOAT NOT NULL,
     CONSTRAINT PK_ScenarioOverride PRIMARY KEY (scenarioId, overrideKey)
   )`,
  `IF OBJECT_ID(N'dbo.ScenarioPurchase', N'U') IS NULL
   CREATE TABLE dbo.ScenarioPurchase (
     scenarioId NVARCHAR(64) NOT NULL
       CONSTRAINT FK_ScenarioPurchase_Scenario REFERENCES dbo.Scenario(id) ON DELETE CASCADE,
     purchaseId NVARCHAR(64) NOT NULL,
     label NVARCHAR(200) NOT NULL,
     purchaseDate DATE NOT NULL,
     amount FLOAT NOT NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_ScenarioPurchase_sortOrder DEFAULT 0,
     CONSTRAINT PK_ScenarioPurchase PRIMARY KEY (scenarioId, purchaseId)
   )`,
  `IF OBJECT_ID(N'dbo.AppState', N'U') IS NULL
   CREATE TABLE dbo.AppState (
     id INT NOT NULL CONSTRAINT PK_AppState PRIMARY KEY CONSTRAINT CK_AppState_singleton CHECK (id = 1),
     activeScenarioId NVARCHAR(64) NULL
   )`,
  // Monthly expense tracker (global, not per-scenario: these are actuals about
  // the real joint account, so scenario operations must never touch them).
  `IF OBJECT_ID(N'dbo.ExpenseTemplate', N'U') IS NULL
   CREATE TABLE dbo.ExpenseTemplate (
     kind NVARCHAR(10) NOT NULL,
     itemId NVARCHAR(64) NOT NULL,
     name NVARCHAR(200) NOT NULL,
     dayOfMonth INT NULL,
     amount FLOAT NOT NULL,
     accountId NVARCHAR(64) NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_ExpenseTemplate_sortOrder DEFAULT 0,
     CONSTRAINT PK_ExpenseTemplate PRIMARY KEY (kind, itemId),
     CONSTRAINT CK_ExpenseTemplate_kind CHECK (kind IN (N'expense', N'income'))
   )`,
  `IF OBJECT_ID(N'dbo.ExpenseMonth', N'U') IS NULL
   CREATE TABLE dbo.ExpenseMonth (
     monthKey NVARCHAR(7) NOT NULL CONSTRAINT PK_ExpenseMonth PRIMARY KEY,
     startBalance FLOAT NOT NULL,
     currentBalance FLOAT NULL,
     updatedAt DATETIME2 NOT NULL CONSTRAINT DF_ExpenseMonth_updatedAt DEFAULT SYSUTCDATETIME()
   )`,
  `IF OBJECT_ID(N'dbo.ExpenseMonthItem', N'U') IS NULL
   CREATE TABLE dbo.ExpenseMonthItem (
     monthKey NVARCHAR(7) NOT NULL
       CONSTRAINT FK_ExpenseMonthItem_ExpenseMonth REFERENCES dbo.ExpenseMonth(monthKey) ON DELETE CASCADE,
     kind NVARCHAR(10) NOT NULL,
     itemId NVARCHAR(64) NOT NULL,
     templateId NVARCHAR(64) NULL,
     name NVARCHAR(200) NOT NULL,
     dayOfMonth INT NULL,
     amount FLOAT NOT NULL,
     paid FLOAT NULL,
     accountId NVARCHAR(64) NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_ExpenseMonthItem_sortOrder DEFAULT 0,
     CONSTRAINT PK_ExpenseMonthItem PRIMARY KEY (monthKey, kind, itemId),
     CONSTRAINT CK_ExpenseMonthItem_kind CHECK (kind IN (N'expense', N'income'))
   )`,
  // Pre-retirement (accumulation) forecast (global, like the expense tracker).
  // Accounts are a user-editable registry of real accounts; each has an owner
  // and a kind (the retirement-pot grouping). accountId tags on expense lines
  // are validated in code, not by FK: the two modules save through independent
  // endpoints/transactions, and a deleted account must not break saved months.
  `IF OBJECT_ID(N'dbo.PreRetirementState', N'U') IS NULL
   CREATE TABLE dbo.PreRetirementState (
     id INT NOT NULL CONSTRAINT PK_PreRetirementState PRIMARY KEY CONSTRAINT CK_PreRetirementState_singleton CHECK (id = 1),
     openingMonth NVARCHAR(7) NOT NULL
   )`,
  `IF OBJECT_ID(N'dbo.PreRetirementAccount', N'U') IS NULL
   CREATE TABLE dbo.PreRetirementAccount (
     accountId NVARCHAR(64) NOT NULL CONSTRAINT PK_PreRetirementAccount PRIMARY KEY,
     name NVARCHAR(200) NOT NULL,
     ownerId NVARCHAR(10) NOT NULL,
     kind NVARCHAR(20) NOT NULL,
     openingBalance FLOAT NOT NULL,
     gainFraction FLOAT NULL,
     sortOrder INT NOT NULL CONSTRAINT DF_PreRetirementAccount_sortOrder DEFAULT 0,
     CONSTRAINT CK_PreRetirementAccount_kind
       CHECK (kind IN (N'isa', N'pension', N'gia', N'savings', N'premiumBonds', N'gilts'))
   )`,
  // Several records per account per month are allowed (a balance can be
  // taken at the end of any day; re-recording later in the month keeps the
  // earlier entry as history), hence the surrogate key. dayOfMonth NULL means
  // end of the month ("day" itself is an ODBC reserved word, like "owner").
  `IF OBJECT_ID(N'dbo.PreRetirementAccountOverride', N'U') IS NULL
   CREATE TABLE dbo.PreRetirementAccountOverride (
     id INT IDENTITY NOT NULL CONSTRAINT PK_PreRetirementAccountOverride PRIMARY KEY,
     accountId NVARCHAR(64) NOT NULL
       CONSTRAINT FK_PreRetirementAccountOverride_Account
       REFERENCES dbo.PreRetirementAccount(accountId) ON DELETE CASCADE,
     monthKey NVARCHAR(7) NOT NULL,
     dayOfMonth INT NULL,
     value FLOAT NOT NULL
   )`,
  // The short-lived fixed-pots schema this registry replaced (shipped empty,
  // superseded the same week — safe to drop).
  `IF OBJECT_ID(N'dbo.PreRetirementOverride', N'U') IS NOT NULL DROP TABLE dbo.PreRetirementOverride`,
  `IF OBJECT_ID(N'dbo.PreRetirementPot', N'U') IS NOT NULL DROP TABLE dbo.PreRetirementPot`,
  // Columns added after the tables first shipped (fresh installs get them in
  // the CREATE TABLE statements above; existing databases via these guards).
  `IF COL_LENGTH(N'dbo.Scenario', N'linkPreRetirement') IS NULL
   ALTER TABLE dbo.Scenario ADD linkPreRetirement BIT NOT NULL
     CONSTRAINT DF_Scenario_linkPreRetirement DEFAULT 0`,
  `IF COL_LENGTH(N'dbo.Scenario', N'taxFreezeUntilYear') IS NULL
   ALTER TABLE dbo.Scenario ADD taxFreezeUntilYear INT NOT NULL
     CONSTRAINT DF_Scenario_taxFreezeUntilYear DEFAULT 2031`,
  `IF COL_LENGTH(N'dbo.Scenario', N'taxUprating') IS NULL
   ALTER TABLE dbo.Scenario ADD taxUprating FLOAT NOT NULL
     CONSTRAINT DF_Scenario_taxUprating DEFAULT 0`,
  // Existing rows default to "custom" / version 1; migrateScenario then re-derives the policy.
  `IF COL_LENGTH(N'dbo.Scenario', N'taxIndexation') IS NULL
   ALTER TABLE dbo.Scenario ADD taxIndexation NVARCHAR(10) NOT NULL
     CONSTRAINT DF_Scenario_taxIndexation DEFAULT N'custom'`,
  `IF COL_LENGTH(N'dbo.Scenario', N'schemaVersion') IS NULL
   ALTER TABLE dbo.Scenario ADD schemaVersion INT NOT NULL
     CONSTRAINT DF_Scenario_schemaVersion DEFAULT 1`,
  // Tax-parameter edits became sparse: every value column is nullable (NULL = not edited).
  ...LEGACY_TAX_PARAM_COLUMNS.map(
    (c) => `IF EXISTS (SELECT 1 FROM sys.columns
                WHERE object_id = OBJECT_ID(N'dbo.ScenarioTaxYearParams') AND name = N'${c}' AND is_nullable = 0)
   ALTER TABLE dbo.ScenarioTaxYearParams ALTER COLUMN [${c}] FLOAT NULL`,
  ),
  ...["savingsBasicRate", "savingsHigherRate", "savingsAdditionalRate"].map(
    (c) => `IF COL_LENGTH(N'dbo.ScenarioTaxYearParams', N'${c}') IS NULL
   ALTER TABLE dbo.ScenarioTaxYearParams ADD [${c}] FLOAT NULL`,
  ),
  `IF COL_LENGTH(N'dbo.ExpenseTemplate', N'accountId') IS NULL
   ALTER TABLE dbo.ExpenseTemplate ADD accountId NVARCHAR(64) NULL`,
  `IF COL_LENGTH(N'dbo.ExpenseMonthItem', N'accountId') IS NULL
   ALTER TABLE dbo.ExpenseMonthItem ADD accountId NVARCHAR(64) NULL`,
  `IF COL_LENGTH(N'dbo.PreRetirementAccountOverride', N'dayOfMonth') IS NULL
   ALTER TABLE dbo.PreRetirementAccountOverride ADD dayOfMonth INT NULL`,
  `IF COL_LENGTH(N'dbo.PreRetirementAccountOverride', N'id') IS NULL
   ALTER TABLE dbo.PreRetirementAccountOverride ADD id INT IDENTITY NOT NULL`,
  // Move the override PK off (accountId, monthKey) onto the surrogate id so a
  // month can hold several records (balances taken on different days).
  `IF EXISTS (
     SELECT 1
     FROM sys.key_constraints kc
     JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE kc.name = N'PK_PreRetirementAccountOverride' AND c.name = N'accountId'
   )
   BEGIN
     ALTER TABLE dbo.PreRetirementAccountOverride DROP CONSTRAINT PK_PreRetirementAccountOverride;
     ALTER TABLE dbo.PreRetirementAccountOverride
       ADD CONSTRAINT PK_PreRetirementAccountOverride PRIMARY KEY (id);
   END`,
];

let poolPromise: Promise<sql.ConnectionPool> | null = null;

async function init(): Promise<sql.ConnectionPool> {
  const master = new sql.ConnectionPool(poolConfig("master"));
  await master.connect();
  try {
    await master
      .request()
      .query(`IF DB_ID(N'${DB_NAME}') IS NULL CREATE DATABASE [${DB_NAME}]`);
  } finally {
    await master.close();
  }

  const pool = new sql.ConnectionPool(poolConfig(DB_NAME));
  await pool.connect();
  for (const ddl of SCHEMA) await pool.request().query(ddl);
  return pool;
}

/** Lazily create the pool (and the database/schema on first use). A failure
 *  resets the cached promise so the next request retries the connection. */
export function getPool(): Promise<sql.ConnectionPool> {
  poolPromise ??= init().catch((e: unknown) => {
    poolPromise = null;
    throw e;
  });
  return poolPromise;
}
