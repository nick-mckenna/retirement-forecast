import type { ExpenseMonth, MonthExpenseItem, MonthIncomeItem } from "../../model/expenseTypes";
import { useExpenseStore } from "../../store/expenseStore";
import { monthWarnings, summariseMonth } from "../../expenses/calc";
import { classForNumber, money } from "../format";

function parseAmount(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDay(v: string): number | null {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(31, Math.max(1, n));
}

export function MonthView({ month }: { month: ExpenseMonth }) {
  const updateMonth = useExpenseStore((st) => st.updateMonth);
  const s = summariseMonth(month);
  const warnings = monthWarnings(month);

  const update = (mut: (m: ExpenseMonth) => void) => updateMonth(month.key, mut);
  const editExpense = (id: string, mut: (e: MonthExpenseItem) => void) =>
    update((m) => {
      const e = m.expenses.find((x) => x.id === id);
      if (e) mut(e);
    });
  const editIncome = (id: string, mut: (e: MonthIncomeItem) => void) =>
    update((m) => {
      const e = m.income.find((x) => x.id === id);
      if (e) mut(e);
    });

  const addExpense = () =>
    update((m) => {
      m.expenses.push({ id: `e${Date.now()}`, templateId: null, name: "New expense", day: null, amount: 0, paid: 0 });
    });
  const addIncome = () =>
    update((m) => {
      m.income.push({ id: `i${Date.now()}`, templateId: null, name: "New income", amount: 0 });
    });

  return (
    <>
      {warnings.length > 0 && (
        <div className="warn-banner">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      <div className="kpi">
        <div className="box">
          <div className="v">{money(s.totalExpenses, 2)}</div>
          <div className="l">Expenses this month</div>
        </div>
        <div className="box">
          <div className="v">{money(s.totalAvailable, 2)}</div>
          <div className="l">Available (start balance + income)</div>
        </div>
        <div className="box">
          <div className={`v ${classForNumber(s.headroom)}`}>{money(s.headroom, 2)}</div>
          <div className="l">Expected end balance</div>
        </div>
        <div className="box">
          <div className={`v ${s.predicted != null ? classForNumber(s.predicted) : ""}`}>
            {s.predicted == null ? "—" : money(s.predicted, 2)}
          </div>
          <div className="l">Predicted (current − still to pay)</div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 900 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Expenses</h2>
          <button className="primary" onClick={addExpense}>
            + Add expense
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Amounts here are this month's own copy — edit them freely without changing the standard
          list. <b>Paid</b> is what has actually left the account so far; <b>To pay</b> is what is
          still due.
        </p>
        <table className="fit zebra">
          <thead>
            <tr>
              <th>Day</th>
              <th className="label">Item</th>
              <th>Amount</th>
              <th>Paid</th>
              <th>To pay</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {month.expenses.map((e) => (
              <tr key={e.id}>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    style={{ width: 55 }}
                    value={e.day ?? ""}
                    onChange={(ev) => editExpense(e.id, (x) => (x.day = parseDay(ev.target.value)))}
                  />
                </td>
                <td className="label">
                  <input
                    type="text"
                    style={{ width: 220 }}
                    value={e.name}
                    onChange={(ev) => editExpense(e.id, (x) => (x.name = ev.target.value))}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step={0.01}
                    value={e.amount}
                    onChange={(ev) => editExpense(e.id, (x) => (x.amount = parseAmount(ev.target.value)))}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step={0.01}
                    value={e.paid}
                    onChange={(ev) => editExpense(e.id, (x) => (x.paid = parseAmount(ev.target.value)))}
                  />
                </td>
                <td className={classForNumber(e.amount - e.paid)}>{money(e.amount - e.paid, 2)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    className="ghost"
                    title="Mark as paid in full"
                    disabled={e.paid === e.amount}
                    onClick={() => editExpense(e.id, (x) => (x.paid = x.amount))}
                  >
                    ✓ Paid
                  </button>{" "}
                  <button className="ghost" onClick={() => update((m) => (m.expenses = m.expenses.filter((x) => x.id !== e.id)))}>
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
              <th>{money(s.totalExpenses, 2)}</th>
              <th>{money(s.totalPaid, 2)}</th>
              <th className={classForNumber(s.totalToPay)}>{money(s.totalToPay, 2)}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card" style={{ maxWidth: 560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Income &amp; balances</h2>
          <button className="primary" onClick={addIncome}>
            + Add income
          </button>
        </div>
        <div className="field" style={{ maxWidth: 380 }}>
          <label>Start balance (carried into the month)</label>
          <input
            type="number"
            step={0.01}
            value={month.startBalance}
            onChange={(ev) => update((m) => (m.startBalance = parseAmount(ev.target.value)))}
          />
        </div>
        <table className="fit zebra">
          <thead>
            <tr>
              <th className="label">Source</th>
              <th>Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {month.income.map((inc) => (
              <tr key={inc.id}>
                <td className="label">
                  <input
                    type="text"
                    style={{ width: 220 }}
                    value={inc.name}
                    onChange={(ev) => editIncome(inc.id, (x) => (x.name = ev.target.value))}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step={0.01}
                    value={inc.amount}
                    onChange={(ev) => editIncome(inc.id, (x) => (x.amount = parseAmount(ev.target.value)))}
                  />
                </td>
                <td>
                  <button className="ghost" onClick={() => update((m) => (m.income = m.income.filter((x) => x.id !== inc.id)))}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="label">Total (with start balance)</th>
              <th>{money(s.totalAvailable, 2)}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
        <div className="field" style={{ maxWidth: 380, marginTop: 14 }}>
          <label>Current account balance right now</label>
          <input
            type="number"
            step={0.01}
            value={month.currentBalance ?? ""}
            placeholder="not entered"
            onChange={(ev) =>
              update((m) => (m.currentBalance = ev.target.value === "" ? null : parseAmount(ev.target.value)))
            }
          />
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
          Enter the balance shown at the bank and the <b>Predicted</b> figure above becomes that
          balance minus everything still to pay — if it goes red, the account will drop below zero
          before the month ends.
        </p>
      </div>
    </>
  );
}
