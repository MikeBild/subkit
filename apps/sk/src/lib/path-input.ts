const INVISIBLE_STRIP = /[\u200B-\u200F\uFEFF]/g;
const NBSP = /\u00A0/g;
const SUSPICIOUS = /[\u00A0\u200B-\u200F\uFEFF]/;

export function sanitizePathInput(s: string): string {
  return s.replace(INVISIBLE_STRIP, "").replace(NBSP, " ").trim();
}

export function renderSuspiciousCodepoints(s: string): string {
  if (!SUSPICIOUS.test(s)) return "";
  const cps = [...s].map((c) => c.codePointAt(0)?.toString(16)).join(" ");
  return ` [codepoints: ${cps}]`;
}
