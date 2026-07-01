import type { OneOffPurchase, Scenario } from "../model/types";
import { useStore } from "../store/scenarioStore";
import { money } from "./format";

export function PurchasesView({ scenario }: { scenario: Scenario }) {
  const update = useStore((st) => st.update);
  const purchases = scenario.purchases ?? [];

  const addPurchase = () => {
    const p: OneOffPurchase = {
      id: `p${Date.now()}`,
      label: "New purchase",
      date: `${scenario.income.startYear + 2}-06-01`,
      amount: 100000,
    };
    update((sc) => {
      (sc.purchases ??= []).push(p);
    });
  };

  const edit = (id: string, mut: (p: OneOffPurchase) => void) =>
    update((sc) => {
      const p = (sc.purchases ??= []).find((x) => x.id === id);
      if (p) mut(p);
    });

  const remove = (id: string) =>
    update((sc) => {
      sc.purchases = (sc.purchases ?? []).filter((x) => x.id !== id);
    });

  const total = purchases.reduce((s, p) => s + p.amount, 0);
  const sorted = [...purchases].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>One-off purchases</h2>
        <button className="primary" onClick={addPurchase}>
          + Add purchase
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        One-off cash requirements (a house, a car, a gift). On each date the model raises the cash by
        selling investments in the most tax-efficient way for your chosen sell strategy, so the tax is
        included, then pays it out. The transactions appear automatically in the Ledger (
        <span className="pill">Fund</span> then <span className="pill">Purchase</span>).
        {purchases.length > 0 && <> Total planned: {money(total)}.</>}
      </p>

      {purchases.length === 0 ? (
        <p className="muted">No purchases yet. Add one to model a large future outlay.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="label">Description</th>
              <th className="label">Date</th>
              <th>Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.id}>
                <td className="label">
                  <input
                    type="text"
                    style={{ width: 220 }}
                    value={p.label}
                    onChange={(e) => edit(p.id, (x) => (x.label = e.target.value))}
                  />
                </td>
                <td className="label">
                  <input
                    type="date"
                    value={p.date}
                    onChange={(e) => edit(p.id, (x) => (x.date = e.target.value))}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step={1000}
                    value={p.amount}
                    onChange={(e) => edit(p.id, (x) => (x.amount = parseFloat(e.target.value) || 0))}
                  />
                </td>
                <td>
                  <button className="ghost" onClick={() => remove(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
