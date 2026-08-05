import { useEffect, useRef, useState, type ReactNode } from "react";

/** A small "i" button that toggles a short explanation next to a figure or
 *  label. Click (or Enter/Space when focused) opens it; Escape or a click
 *  outside closes it. Keep the children to a couple of short paragraphs —
 *  it is a hint, not documentation. */
export function InfoIcon({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="info" ref={ref}>
      <button
        type="button"
        className="info-btn"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <div className="info-pop" role="tooltip">
          {children}
        </div>
      )}
    </span>
  );
}
