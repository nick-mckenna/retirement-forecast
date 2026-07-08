#!/usr/bin/env bash
#
# Back up the production RetirementForecast database to the financial vault on
# Google Drive as a .bacpac (schema + data in one portable file; restore with
# sqlpackage /Action:Import).
#
# The local SQL Server instance has TCP/IP disabled, so the export connects
# over shared memory (lpc:). Credentials come from containerSecrets/
# sql-creds.json — the same file the app's API server reads. Note the password
# is passed to sqlpackage on its command line, so it is briefly visible in the
# local process list while the export runs.
#
# Requires sqlpackage:  dotnet tool install -g microsoft.sqlpackage
# Run from Git Bash:    scripts/backup-db.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDS_FILE="$REPO_DIR/containerSecrets/sql-creds.json"
DB_NAME="${RETIREMENT_DB_NAME:-RetirementForecast}"
DEST_DIR="/g/My Drive/Documents/Vault/Financial/Backup"
# Timestamped so every run keeps its own file rather than overwriting.
DEST="$DEST_DIR/$DB_NAME-$(date +%Y-%m-%d_%H%M%S).bacpac"

[[ -f "$CREDS_FILE" ]] || { echo "Credentials not found: $CREDS_FILE" >&2; exit 1; }
[[ -d "$DEST_DIR" ]] || { echo "Backup folder not found (Google Drive not mounted?): $DEST_DIR" >&2; exit 1; }

SQLPACKAGE="$(command -v sqlpackage || true)"
[[ -n "$SQLPACKAGE" ]] || SQLPACKAGE="$HOME/.dotnet/tools/sqlpackage"
[[ -x "$SQLPACKAGE" ]] || { echo "sqlpackage not found — install with: dotnet tool install -g microsoft.sqlpackage" >&2; exit 1; }

USERNAME="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).username' "$CREDS_FILE")"
PASSWORD="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).password' "$CREDS_FILE")"

# Export to a local temp file first so a failed export can never clobber the
# last good backup on the Drive, then copy + rename on the Drive side.
TMP_FILE="$(mktemp -u "${TMPDIR:-/tmp}/$DB_NAME.XXXXXX.bacpac")"
trap 'rm -f "$TMP_FILE"' EXIT

# MSYS_NO_PATHCONV stops Git Bash rewriting the /Flag:value args as paths.
MSYS_NO_PATHCONV=1 "$SQLPACKAGE" /Action:Export \
  /SourceServerName:lpc:localhost \
  /SourceDatabaseName:"$DB_NAME" \
  /SourceUser:"$USERNAME" \
  /SourcePassword:"$PASSWORD" \
  /SourceTrustServerCertificate:True \
  /SourceEncryptConnection:False \
  /TargetFile:"$(cygpath -w "$TMP_FILE")" \
  /OverwriteFiles:True

cp "$TMP_FILE" "$DEST.partial"
mv -f "$DEST.partial" "$DEST"
echo "Backed up $DB_NAME to $DEST ($(du -h "$DEST" | cut -f1))"
