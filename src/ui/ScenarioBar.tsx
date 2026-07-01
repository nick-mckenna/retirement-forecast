import { useRef } from "react";
import type { Scenario } from "../model/types";
import type { SimResult } from "../engine/simulate";
import { useStore } from "../store/scenarioStore";
import { exportToExcel } from "../export/excelExport";

export function ScenarioBar({ scenario, result }: { scenario: Scenario; result: SimResult }) {
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${scenario.name.replace(/[^\w -]/g, "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(String(reader.result)) as Scenario;
        store.importScenario(s);
      } catch {
        alert("Could not parse that scenario file.");
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
      <span style={{ flex: 1 }} />
      <button onClick={exportJson}>Export JSON</button>
      <button onClick={() => fileRef.current?.click()}>Import JSON</button>
      <button className="primary" onClick={() => void exportToExcel(scenario, result)}>
        Export to Excel
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
      />
    </div>
  );
}
