import type { DbStatus } from "../store/scenarioStore";

/** The little "is this being saved to SQL Server?" indicator. */
export function DbChip({ status }: { status: DbStatus }) {
  const db =
    status === "online"
      ? { color: "#3fb950", text: "● SQL Server", title: "Data is being saved to your local SQL Server database" }
      : status === "offline"
        ? { color: "#f85149", text: "○ DB offline", title: "Database unreachable — changes stay in this browser until it is back" }
        : { color: "#8b949e", text: "… connecting", title: "Connecting to the forecast database" };

  return (
    <span style={{ fontSize: 12, color: db.color, whiteSpace: "nowrap" }} title={db.title}>
      {db.text}
    </span>
  );
}
