import { useExpenseStore } from "../../store/expenseStore";
import { money } from "../format";
import { AccountSelect } from "./AccountSelect";

function parseAmount(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDay(v: string): number | null {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(31, Math.max(1, n));
}

/** Editor for the standard monthly expenses and income sources. These are the
 *  master lists snapshotted into each newly created month; existing months
 *  keep their own copies, so edits here never rewrite history. */
export function TemplatesView() {
  const templates = useExpenseStore((st) => st.data.templates);
  const updateTemplates = useExpenseStore((st) => st.updateTemplates);

  const totalExpenses = templates.expenses.reduce((s, e) => s + e.amount, 0);
  const totalIncome = templates.income.reduce((s, i) => s + i.amount, 0);

  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        The standard set of monthly expenses and income sources. New months start as a copy of
        these lists; months already created are not affected by changes here. Leave the amount at 0
        for items that vary every month (card bills) and fill them in on the month itself. Tag a
        line with an investment account and every new month inherits the tag — that is how regular
        contributions reach the pre-retirement forecast.
      </p>
      <div className="grid-2" style={{ alignItems: "start", gap: 18, maxWidth: 1400 }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Standard expenses</h2>
            <button
              className="primary"
              onClick={() =>
                updateTemplates((t) => {
                  t.expenses.push({ id: `e${Date.now()}`, name: "New expense", day: null, amount: 0, accountId: null });
                })
              }
            >
              + Add
            </button>
          </div>
          <div style={{ overflowX: "auto" }}>
          <table className="fit zebra">
            <thead>
              <tr>
                <th>Day</th>
                <th className="label">Item</th>
                <th>Pays into</th>
                <th>Default amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.expenses.map((e) => (
                <tr key={e.id}>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      style={{ width: 55 }}
                      value={e.day ?? ""}
                      onChange={(ev) =>
                        updateTemplates((t) => {
                          const x = t.expenses.find((i) => i.id === e.id);
                          if (x) x.day = parseDay(ev.target.value);
                        })
                      }
                    />
                  </td>
                  <td className="label">
                    <input
                      type="text"
                      style={{ width: 200 }}
                      value={e.name}
                      onChange={(ev) =>
                        updateTemplates((t) => {
                          const x = t.expenses.find((i) => i.id === e.id);
                          if (x) x.name = ev.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <AccountSelect
                      value={e.accountId}
                      onChange={(v) =>
                        updateTemplates((t) => {
                          const x = t.expenses.find((i) => i.id === e.id);
                          if (x) x.accountId = v;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step={0.01}
                      value={e.amount}
                      onChange={(ev) =>
                        updateTemplates((t) => {
                          const x = t.expenses.find((i) => i.id === e.id);
                          if (x) x.amount = parseAmount(ev.target.value);
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() =>
                        updateTemplates((t) => {
                          t.expenses = t.expenses.filter((i) => i.id !== e.id);
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th></th>
                <th className="label">Total</th>
                <th></th>
                <th>{money(totalExpenses, 2)}</th>
                <th></th>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Standard income</h2>
            <button
              className="primary"
              onClick={() =>
                updateTemplates((t) => {
                  t.income.push({ id: `i${Date.now()}`, name: "New income", amount: 0, accountId: null });
                })
              }
            >
              + Add
            </button>
          </div>
          <div style={{ overflowX: "auto" }}>
          <table className="fit zebra">
            <thead>
              <tr>
                <th className="label">Source</th>
                <th>From account</th>
                <th>Default amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.income.map((inc) => (
                <tr key={inc.id}>
                  <td className="label">
                    <input
                      type="text"
                      style={{ width: 200 }}
                      value={inc.name}
                      onChange={(ev) =>
                        updateTemplates((t) => {
                          const x = t.income.find((i) => i.id === inc.id);
                          if (x) x.name = ev.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <AccountSelect
                      value={inc.accountId}
                      onChange={(v) =>
                        updateTemplates((t) => {
                          const x = t.income.find((i) => i.id === inc.id);
                          if (x) x.accountId = v;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step={0.01}
                      value={inc.amount}
                      onChange={(ev) =>
                        updateTemplates((t) => {
                          const x = t.income.find((i) => i.id === inc.id);
                          if (x) x.amount = parseAmount(ev.target.value);
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() =>
                        updateTemplates((t) => {
                          t.income = t.income.filter((i) => i.id !== inc.id);
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="label" colSpan={2}>Total</th>
                <th>{money(totalIncome, 2)}</th>
                <th></th>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>
      </div>
    </>
  );
}
