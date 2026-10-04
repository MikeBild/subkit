export function envIntOr(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

export function envCsvOr(name: string, defaultValue: readonly string[]): readonly string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return defaultValue;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return defaultValue;
  return parts;
}
