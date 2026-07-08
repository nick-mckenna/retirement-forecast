import { useRef } from "react";
import type { Scenario } from "../model/types";
import type { SimResult } from "../engine/simulate";
import { useStore } from "../store/scenarioStore";
import { applyRestoredExpenses, useExpenseStore } from "../store/expenseStore";
import { exportToExcel } from "../export/excelExport";
import { api, BACKUP_FORMAT, type BackupFile } from "../api/client";
import { DbChip } from "./DbChip";

function download(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ScenarioBar({ scenario, result }: { scenario: Scenario; result: SimResult }) {
  const store = useStore();
  const dbStatus = useStore((st) => st.dbStatus);
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = async () => {
    const filename = `retirement-forecast-backup-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      download(await api.exportBackup(), filename);
    } catch {
      // Database unreachable: back up what the browser has instead.
      const backup: BackupFile = {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        activeId: store.activeId,
        scenarios: store.scenarios,
        expenses: useExpenseStore.getState().data,
      };
      download(backup, filename);
    }
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as BackupFile | Scenario;
        if ("format" in parsed && parsed.format === BACKUP_FORMAT && Array.isArray(parsed.scenarios)) {
          if (parsed.scenarios.length === 0) {
            alert("That backup file contains no scenarios.");
            return;
          }
          const ok = confirm(
            `Restore "${file.name}"?\n\nThis replaces ALL ${store.scenarios.length} scenario(s) ` +
              `in the database with the ${parsed.scenarios.length} scenario(s) from the backup` +
              (parsed.expenses ? ", plus the monthly expense tracker data" : "") +
              `.`,
          );
          if (!ok) return;
          const where = await store.restoreBackup(parsed);
          await applyRestoredExpenses(parsed.expenses, where);
          if (where === "browser-only") {
            alert("Database not reachable — the backup was restored to browser storage only.");
          }
        } else if ("people" in parsed && "balances" in parsed) {
          // Legacy single-scenario file: add it alongside the existing ones.
          store.importScenario(parsed);
        } else {
          alert("That file is neither a backup nor a scenario.");
        }
      } catch {
        alert("Could not parse that file.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
      <select value={store.activeId} onChange={(e) => store.setActive(e.target.value)}>
        {store.scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        value={scenario.name}
        style={{ width: 200 }}
        onChange={(e) => store.rename(e.target.value)}
      />
      <button onClick={() => store.addScenario()}>+ New</button>
      <button onClick={() => store.duplicateActive()}>Duplicate</button>
      <button onClick={() => store.deleteActive()} disabled={store.scenarios.length <= 1}>
        Delete
      </button>
      <button onClick={() => store.resetActiveToDefault()}>Reset to base case</button>
      <DbChip status={dbStatus} />
      <span style={{ flex: 1 }} />
      <button onClick={() => void exportJson()} title="Download every scenario in the database as a JSON backup">
        Export JSON
      </button>
      <button onClick={() => fileRef.current?.click()} title="Restore a JSON backup (or add a single exported scenario)">
        Import JSON
      </button>
      <button className="primary" onClick={() => void exportToExcel(scenario, result)}>
        Export to Excel
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.[0]) importJson(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
