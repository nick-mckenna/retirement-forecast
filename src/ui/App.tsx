import { useMemo, useState } from "react";
import { useStore } from "../store/scenarioStore";
import { runForecast } from "../strategy/optimiser";
import { InputsPanel } from "./InputsPanel";
import { Charts } from "./Charts";
import { LedgerTable } from "./LedgerTable";
import { PurchasesView } from "./PurchasesView";
import { GiltsView } from "./GiltsView";
import { DisposalsView } from "./DisposalsView";
import { TaxView } from "./TaxView";
import { IncomeTargetsView } from "./IncomeTargetsView";
import { TaxParamsEditor } from "./TaxParamsEditor";
import { ScenarioBar } from "./ScenarioBar";
import { money } from "./format";

type Tab = "dashboard" | "ledger" | "purchases" | "tax" | "disposals" | "gilts" | "income" | "taxparams";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "ledger", label: "Ledger" },
  { id: "purchases", label: "Purchases" },
  { id: "tax", label: "Tax & strategy" },
  { id: "disposals", label: "Asset disposals" },
  { id: "gilts", label: "Gilts" },
  { id: "income", label: "Income targets" },
  { id: "taxparams", label: "Tax parameters" },
];

export function App() {
  const scenario = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const [tab, setTab] = useState<Tab>("dashboard");

  const outcome = useMemo(() => runForecast(scenario), [scenario]);
  const result = outcome.result;

  const last = result.years[result.years.length - 1];
  const totalTax = outcome.totalTax;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 style={{ fontSize: 18 }}>Retirement Forecast</h1>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Local-first · your data stays on this machine (SQL Server)
        </p>
        <InputsPanel />
      </aside>

      <main className="main">
        <ScenarioBar scenario={scenario} result={result} />

        {result.warnings.length > 0 && (
          <div className="warn-banner">
            {result.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        {scenario.strategy.taxMode === "lifetime" && outcome.search && (
          <div className="warn-banner" style={{ background: "#12302a", borderColor: "var(--accent-2)", color: "var(--accent-2)" }}>
            Lifetime optimiser: searched {outcome.search.length} crystallisation strategies and chose{" "}
            {outcome.chosenFraction == null
              ? "no proactive pension crystallisation"
              : `filling to ${Math.round(outcome.chosenFraction * 100)}% of the basic-rate band each year`}{" "}
            → lowest total tax {money(outcome.totalTax)}.
          </div>
        )}

        <div className="kpi">
          <div className="box">
            <div className="v">{money(last?.netWorthEnd ?? 0)}</div>
            <div className="l">Net worth {last ? last.taxYearStart + 1 : ""}</div>
          </div>
          <div className="box">
            <div className="v">{money(totalTax)}</div>
            <div className="l">Total tax over plan</div>
          </div>
          <div className="box">
            <div className="v">{money(result.years[0]?.bufferEnd ?? 0)}</div>
            <div className="l">Buffer (year 1 end)</div>
          </div>
          <div className="box">
            <div className="v">{scenario.income.years} yrs</div>
            <div className="l">
              {scenario.income.startYear}–{scenario.income.startYear + scenario.income.years}
            </div>
          </div>
        </div>

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "dashboard" && <Charts result={result} />}
        {tab === "ledger" && <LedgerTable result={result} />}
        {tab === "purchases" && <PurchasesView scenario={scenario} />}
        {tab === "tax" && <TaxView result={result} />}
        {tab === "disposals" && <DisposalsView result={result} scenario={scenario} />}
        {tab === "gilts" && <GiltsView result={result} />}
        {tab === "income" && <IncomeTargetsView scenario={scenario} />}
        {tab === "taxparams" && <TaxParamsEditor scenario={scenario} />}
      </main>
    </div>
  );
}
