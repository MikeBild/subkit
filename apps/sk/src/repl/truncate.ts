const ELLIPSIS = "…";

function len(s: string): number {
  return [...s].length;
}

function take(s: string, n: number): string {
  if (n <= 0) return "";
  return [...s].slice(0, n).join("");
}

function takeRight(s: string, n: number): string {
  if (n <= 0) return "";
  const cps = [...s];
  return cps.slice(cps.length - n).join("");
}

export function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (len(s) <= max) return s;
  if (max === 1) return ELLIPSIS;
  return take(s, max - 1) + ELLIPSIS;
}

export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return "";
  if (len(s) <= max) return s;
  if (max <= 2) return ELLIPSIS;
  const remain = max - 1;
  const headLen = Math.ceil(remain / 2);
  const tailLen = Math.floor(remain / 2);
  return take(s, headLen) + ELLIPSIS + takeRight(s, tailLen);
}
