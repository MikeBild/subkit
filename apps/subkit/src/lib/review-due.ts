const CLEAR_WORDS = new Set(["none", "never", "clear"]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function reviewDueValue(input: string): string | null {
  const value = input.trim();
  if (CLEAR_WORDS.has(value.toLowerCase())) return null;
  const iso = DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value;
  if (!DATE_TIME.test(iso) || Number.isNaN(Date.parse(iso)))
    throw new Error("--review-due must be a date like 2026-12-31, a full ISO time, or none");
  return new Date(iso).toISOString();
}
