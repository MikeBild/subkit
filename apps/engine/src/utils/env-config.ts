// Tiny helpers for reading operator-tunable knobs from `process.env` at
// module load. Used by docs-ingestion budgets, knowledge budgets, and the
// playwright crawl scoring lists.
//
// Each helper returns the default when the env var is unset, empty, or
// fails to parse. Operators can change values without a recompile, but
// the codebase keeps a sane fallback so dev and test environments don't
// require explicit configuration.

/** Parse a positive integer from env, returning the default on miss. */
export function envIntOr(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.floor(n);
}

/**
 * Parse a comma-separated list from env. Empty / unset → default.
 * Whitespace around entries is trimmed; empty entries are dropped.
 */
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
