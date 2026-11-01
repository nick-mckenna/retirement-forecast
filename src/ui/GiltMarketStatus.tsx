import { useGiltMarketStore } from "../store/giltMarketStore";
import { shortDate } from "./format";

/** "DMO prices: 30/10/2026 [Refresh]" — the gilt market's as-of date and a manual refresh. The
 *  refresh asks the local server to fetch the Debt Management Office's public reports. */
export function GiltMarketStatus() {
  const market = useGiltMarketStore((st) => st.market);
  const status = useGiltMarketStore((st) => st.status);
  const error = useGiltMarketStore((st) => st.error);
  const refresh = useGiltMarketStore((st) => st.refresh);
  const busy = status === "refreshing" || status === "loading";
  return (
    <span style={{ fontSize: 12, display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="muted" title="Gilts in issue (DMO report D1A) and purchase & sale prices (D10B)">
        DMO gilt prices: {market?.asOf ? shortDate(market.asOf) : "none yet"}
      </span>
      <button className="ghost" disabled={busy} onClick={() => void refresh()}>
        {status === "refreshing" ? "Fetching…" : "Refresh"}
      </button>
      {error && (
        <span style={{ color: "#f0883e" }} title={error}>
          ⚠ {error.length > 90 ? `${error.slice(0, 90)}…` : error}
        </span>
      )}
    </span>
  );
}
