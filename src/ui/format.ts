const gbp0 = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const gbp2 = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 2,
});

export function money(x: number, dp = 0): string {
  if (x === 0) return "—";
  return (dp === 0 ? gbp0 : gbp2).format(x);
}

export function pct(x: number, dp = 2): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function classForNumber(x: number): string {
  return x < 0 ? "num-neg" : "";
}
