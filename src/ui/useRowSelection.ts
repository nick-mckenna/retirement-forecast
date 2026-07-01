import { useState } from "react";

/**
 * Click-to-pin row highlighting for wide tables, so a row can be read across easily.
 * Clicking a row selects it; clicking it again clears the selection.
 */
export function useRowSelection() {
  const [selected, setSelected] = useState<string | number | null>(null);
  const toggle = (key: string | number) =>
    setSelected((cur) => (cur === key ? null : key));
  const isSelected = (key: string | number) => selected === key;

  /** Merge the "selectable"/"selected" classes with any base row class. */
  const rowClass = (key: string | number, base = ""): string => {
    return [base, "selectable", isSelected(key) ? "selected" : ""].filter(Boolean).join(" ");
  };

  return { selected, isSelected, toggle, rowClass };
}
