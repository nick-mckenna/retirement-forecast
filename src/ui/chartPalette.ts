// The app's person colours — one source for the charts, the CSS variables (src/index.css
// --nick/--tracy and their -text tones) and the Snapshot PDF.
//
// Validated with the dataviz skill's validate_palette.js (OKLab, Machado 2009 CVD simulation):
// categorical [A, B, total] passes every check on the dark card surface #17212b and on white
// (the PDF) — worst all-pairs CVD ΔE 8.4 (protan, A↔B), normal-vision ΔE 18.9, contrast ≥ 3:1.
// The 8.4 sits just above the 8 target, so person identity is never colour alone: the bars
// keep a fixed order (A then B) and the legend and tooltip name them. Each person's stack
// tints pass the --ordinal checks (one hue, monotone lightness, visible steps).

import type { PersonId } from "../model/types";

/** Chart marks (bars, swatches, PDF table headers with white text). */
export const PERSON_COLORS: Record<PersonId, string> = {
  nick: "#1b68cf",
  tracy: "#a970f2",
};

/** Text in a person's colour on the dark UI surfaces (≥ 4.5:1 on --bg, --panel and --panel-2);
 *  the mark colours are too dark for small text there. */
export const PERSON_TEXT_COLORS: Record<PersonId, string> = {
  nick: "#7aa7ee",
  tracy: "#b98af4",
};

/** Stacked income segments per person, bottom to top: drawdown, State Pension, one-off income. */
export const PERSON_INCOME_TINTS: Record<PersonId, readonly [string, string, string]> = {
  nick: ["#1b68cf", "#5f95e8", "#a3c3f5"],
  tracy: ["#a970f2", "#c69df7", "#e2cdfb"],
};

/** Household totals (and the accent line drawn over the person bars). */
export const TOTAL_COLOR = "#1fa37a";

/** The chart card surface, for 2px separating gaps between stacked segments. */
export const CHART_SURFACE = "#17212b";
