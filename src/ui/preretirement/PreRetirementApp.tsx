import { useMemo, useState } from "react";
import { usePreRetirementStore } from "../../store/preRetirementStore";
import { useExpenseStore } from "../../store/expenseStore";
import { useStore } from "../../store/scenarioStore";
import { latestActualTotal, projectAccounts, ratesForKinds } from "../../preretirement/project";
import { handoffMonthKey } from "../../preretirement/link";
import { monthKeyOf, monthLabel } from "../../expenses/calc";
import { money, pct, shortDate } from "../format";
import { DbChip } from "../DbChip";
import { InfoIcon } from "../InfoIcon";
import { ForecastView } from "./ForecastView";
import { AccountsView } from "./AccountsView";
import { SnapshotView } from "./SnapshotView";

// The pre-retirement (accumulation) module: projects the registry of real
// investment accounts month by month from the opening balances to the month
// before the active scenario's retirement start date. Contributions come from
// tagged expense/income lines in the monthly expense tracker; growth rates
// come from the active scenario's rates via each account's kind.

type Tab = "forecast" | "accounts" | "snapshot";

const TABS: { id: Tab; label: string }[] = [
  { id: "forecast", label: "Forecast" },
  { id: "accounts", label: "Accounts" },
  { id: "snapshot", label: "Snapshot" },
];

export function PreRetirementApp() {
  const data = usePreRetirementStore((st) => st.data);
  const dbStatus = usePreRetirementStore((st) => st.dbStatus);
  const expenseMonths = useExpenseStore((st) => st.data.months);
  const addMonthsUntil = useExpenseStore((st) => st.addMonthsUntil);
  const scenario = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const [tab, setTab] = useState<Tab>("forecast");

  const endMonth = handoffMonthKey(scenario.startDate);
  const kindRates = ratesForKinds(scenario.rates);
  const result = useMemo(
    () => projectAccounts(data, expenseMonths, ratesForKinds(scenario.rates), endMonth),
    [data, expenseMonths, scenario.rates, endMonth],
  );

  const todayKey = monthKeyOf(new Date());
  const last = result.months[result.months.length - 1];
  const todayMonth = result.months.find((m) => m.key === todayKey);
  const actual = useMemo(() => latestActualTotal(data), [data]);

  return (
    <main className="main">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Runs to {monthLabel(endMonth)} — the month before “{scenario.name}” starts; growth uses that
          scenario's rates.
        </span>
        <span style={{ flex: 1 }} />
        <DbChip status={dbStatus} />
      </div>

      {result.warnings.length > 0 && (
        <div className="warn-banner">
          {result.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
          {result.missingMonthKeys.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <button className="primary" onClick={() => addMonthsUntil(endMonth)}>
                + Add expense months up to {monthLabel(endMonth)}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="kpi">
        <div className="box">
          <div className="v">{money(actual.total)}</div>
          <div className="l">
            Latest actual balance{actual.latestDate ? ` (${shortDate(actual.latestDate)})` : ""}{" "}
            <InfoIcon label="How “Latest actual balance” is calculated">
              <p>
                The balances you have <b>actually recorded</b>, added up — no forecasting at all: no
                growth, no contributions, nothing projected forward.
              </p>
              <p>
                For each account it takes the most recent figure in the Accounts tab's{" "}
                <b>Latest actual balance</b> column.{" "}
                {actual.openingCount > 0 ? (
                  <>
                    {actual.openingCount} of {actual.openingCount + actual.recordedCount} account(s)
                    have no recorded balance yet, so their <b>opening balance</b> (start of{" "}
                    {monthLabel(data.openingMonth)}) is used instead.
                  </>
                ) : (
                  <>Every account has a recorded balance.</>
                )}
              </p>
              <p className="muted">
                Records are dated individually, so this can mix figures taken on different days
                {actual.latestDate ? ` — the date shown is the most recent of them` : ""}.
              </p>
            </InfoIcon>
          </div>
        </div>
        <div className="box">
          <div className="v">{todayMonth ? money(todayMonth.total) : "—"}</div>
          <div className="l">
            Investments forecast at end of {monthLabel(todayKey)}{" "}
            <InfoIcon label="How the investments forecast is calculated">
              <p>
                The projected total across every account at the <b>end of {monthLabel(todayKey)}</b>{" "}
                — the last month of the forecast that has already started.
              </p>
              <p>
                Each account starts at its opening balance (start of {monthLabel(data.openingMonth)})
                and is walked forward month by month: growth first — ISA / Pension / GIA{" "}
                {pct(scenario.rates.investmentGrowth)}, Savings and Premium Bonds{" "}
                {pct(scenario.rates.savingsInterest)}, Gilts {pct(scenario.rates.giltCoupon)} a year,
                applied at the equivalent monthly rate — then the expense-tracker lines tagged to
                that account (expenses in, income out, using the expected amount rather than what is
                marked paid).
              </p>
              <p>
                Wherever you have recorded an actual balance, the projection re-anchors to it and
                compounds on from there: actuals up to your latest record, forecast after it.
              </p>
            </InfoIcon>
          </div>
        </div>
        <div className="box">
          <div className="v">{last ? money(last.total) : "—"}</div>
          <div className="l">At retirement handoff ({monthLabel(endMonth)})</div>
        </div>
        <div className="box">
          <div className="v">{result.months.length}</div>
          <div className="l">
            Months modelled ({monthLabel(data.openingMonth)} – {monthLabel(endMonth)})
          </div>
        </div>
      </div>

      {tab === "forecast" && <ForecastView result={result} accounts={data.accounts} />}
      {tab === "accounts" && <AccountsView scenario={scenario} />}
      {tab === "snapshot" && (
        <SnapshotView result={result} data={data} expenseMonths={expenseMonths} rates={kindRates} />
      )}
    </main>
  );
}
