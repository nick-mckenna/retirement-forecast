import { useDeferredValue, useMemo, useState } from "react";
import { useStore } from "../store/scenarioStore";
import { usePreRetirementStore } from "../store/preRetirementStore";
import { useExpenseStore } from "../store/expenseStore";
import { resolveScenarioForRun } from "../preretirement/link";
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

export function RetirementApp() {
  const stored = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!);
  const preData = usePreRetirementStore((st) => st.data);
  const expenseMonths = useExpenseStore((st) => st.data.months);
  const [tab, setTab] = useState<Tab>("dashboard");

  // When the scenario is linked, its starting balances come from the
  // pre-retirement projection; the engine itself stays untouched.
  const resolved = useMemo(
    () => resolveScenarioForRun(stored, preData, expenseMonths),
    [stored, preData, expenseMonths],
  );
  const scenario = resolved.scenario;
  // The lifetime search runs a dozen full simulations; deferring it keeps typing in the inputs
  // responsive (React shows the previous forecast until the new one is ready).
  const deferredScenario = useDeferredValue(scenario);
  const outcome = useMemo(() => runForecast(deferredScenario), [deferredScenario]);
  const result = outcome.result;

  const warnings = [...resolved.warnings, ...result.warnings];
  const last = result.years[result.years.length - 1];
  const totalTax = outcome.totalTax;

  return (
    <div className="app">
      <aside className="sidebar">
        <InputsPanel />
      </aside>

      <main className="main">
        <ScenarioBar scenario={scenario} result={result} />

        {warnings.length > 0 && (
          <div className="warn-banner">
            {warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        {scenario.strategy.taxMode === "lifetime" && outcome.search && (
          <div className="warn-banner" style={{ background: "#12302a", borderColor: "var(--accent-2)", color: "var(--accent-2)" }}>
            Lifetime optimiser: searched {outcome.search.length} whole-plan strategies and chose{" "}
            {outcome.chosen?.strategy === "heuristic"
              ? "the rules-based plan"
              : outcome.chosen?.strategy === "annual"
                ? "the annual optimiser with no proactive pension crystallisation"
                : `crystallising pension up to ${Math.round((outcome.chosenFraction ?? 0) * 100)}% of the basic-rate band each year`}{" "}
            → lowest total tax {money(outcome.totalTax)}. (It minimises lifetime tax; tax still due on pensions
            left at the end isn't counted.)
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

        {tab === "dashboard" && <Charts result={result} scenario={scenario} />}
        {tab === "ledger" && <LedgerTable result={result} scenario={scenario} />}
        {tab === "purchases" && <PurchasesView scenario={scenario} />}
        {tab === "tax" && <TaxView result={result} scenario={scenario} />}
        {tab === "disposals" && <DisposalsView result={result} scenario={scenario} />}
        {tab === "gilts" && <GiltsView result={result} scenario={scenario} />}
        {tab === "income" && <IncomeTargetsView scenario={scenario} />}
        {tab === "taxparams" && <TaxParamsEditor scenario={scenario} />}
      </main>
    </div>
  );
}
