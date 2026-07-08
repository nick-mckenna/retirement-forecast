import { useState } from "react";
import { useExpenseStore } from "../../store/expenseStore";
import { monthKeyOf, monthLabel, nextMonthKey, sortedMonths } from "../../expenses/calc";
import { DbChip } from "../DbChip";
import { MonthView } from "./MonthView";
import { TemplatesView } from "./TemplatesView";

// The monthly expense tracker module (the app's second core function). It
// reproduces Expenditure<year>.xlsx: one editable record per actual month,
// snapshotted from the standard items, so the joint current account can be
// kept above zero.

type Tab = "month" | "templates";

export function ExpensesApp() {
  const data = useExpenseStore((st) => st.data);
  const selectedKey = useExpenseStore((st) => st.selectedKey);
  const dbStatus = useExpenseStore((st) => st.dbStatus);
  const select = useExpenseStore((st) => st.select);
  const addMonth = useExpenseStore((st) => st.addMonth);
  const deleteMonth = useExpenseStore((st) => st.deleteMonth);
  const [tab, setTab] = useState<Tab>("month");

  const months = sortedMonths(data);
  const month = months.find((m) => m.key === selectedKey) ?? null;
  const nextKey = nextMonthKey(data, monthKeyOf(new Date()));

  const removeMonth = () => {
    if (!month) return;
    if (confirm(`Delete ${monthLabel(month.key)} and everything recorded in it? This cannot be undone.`)) {
      deleteMonth(month.key);
    }
  };

  return (
    <main className="main">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          <button className={tab === "month" ? "active" : ""} onClick={() => setTab("month")}>
            Months
          </button>
          <button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>
            Standard items
          </button>
        </div>
        {tab === "month" && months.length > 0 && (
          <>
            <select value={selectedKey ?? ""} onChange={(e) => select(e.target.value)}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {monthLabel(m.key)}
                </option>
              ))}
            </select>
            <button className="primary" onClick={addMonth}>
              + Add {monthLabel(nextKey)}
            </button>
            <button onClick={removeMonth} disabled={!month}>
              Delete month
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <DbChip status={dbStatus} />
      </div>

      {tab === "templates" && <TemplatesView />}
      {tab === "month" &&
        (month ? (
          <MonthView month={month} />
        ) : (
          <div className="card">
            <h2>No months tracked yet</h2>
            <p className="muted" style={{ fontSize: 13 }}>
              Add your first month to start tracking. It is created from the standard expenses and
              income sources (see the <b>Standard items</b> tab — edit those first if they need
              updating), and every line can then be overridden for that month without affecting the
              standard list.
            </p>
            <button className="primary" onClick={addMonth}>
              + Add {monthLabel(nextKey)}
            </button>
          </div>
        ))}
    </main>
  );
}
