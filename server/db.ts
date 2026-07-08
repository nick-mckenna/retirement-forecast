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

export const DB_NAME = "RetirementForecast";

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
     personalAllowance FLOAT NOT NULL,
     paTaperThreshold FLOAT NOT NULL,
     basicRateBand FLOAT NOT NULL,
     higherRateBand FLOAT NOT NULL,
     basicRate FLOAT NOT NULL,
     higherRate FLOAT NOT NULL,
     additionalRate FLOAT NOT NULL,
     psaBasic FLOAT NOT NULL,
     psaHigher FLOAT NOT NULL,
     savingsStartingRateBand FLOAT NOT NULL,
     dividendAllowance FLOAT NOT NULL,
     dividendBasicRate FLOAT NOT NULL,
     dividendHigherRate FLOAT NOT NULL,
     dividendAdditionalRate FLOAT NOT NULL,
     cgtAnnualExempt FLOAT NOT NULL,
     cgtBasicRate FLOAT NOT NULL,
     cgtHigherRate FLOAT NOT NULL,
     isaAllowance FLOAT NOT NULL,
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
