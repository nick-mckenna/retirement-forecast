import { useState } from "react";
import { RetirementApp } from "./RetirementApp";
import { ExpensesApp } from "./expenses/ExpensesApp";

// Top-level shell: the app is growing beyond retirement forecasting into a
// small suite (retirement forecast, monthly expense tracking, and eventually
// pre-retirement forecasting), so navigation starts with a module switch and
// each module owns its own layout below the bar.

type Module = "retirement" | "expenses";

const MODULES: { id: Module; label: string }[] = [
  { id: "retirement", label: "Retirement forecast" },
  { id: "expenses", label: "Monthly expenses" },
];

export function App() {
  const [module, setModule] = useState<Module>("retirement");

  return (
    <div>
      <header className="module-bar">
        <div className="module-title">
          <h1>Household Finance</h1>
          <span className="muted">Local-first · your data stays on this machine (SQL Server)</span>
        </div>
        <nav className="tabs module-tabs">
          {MODULES.map((m) => (
            <button key={m.id} className={module === m.id ? "active" : ""} onClick={() => setModule(m.id)}>
              {m.label}
            </button>
          ))}
        </nav>
      </header>

      {module === "retirement" && <RetirementApp />}
      {module === "expenses" && <ExpensesApp />}
    </div>
  );
}
