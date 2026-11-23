const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function reviewDueAt(source: { review_due_at: string | null }): string | null {
  const raw = source.review_due_at;
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

export function reviewDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

export function reviewDateBody(input: string): string | null | undefined {
  const value = input.trim();
  if (!value) return null;
  if (!DATE_ONLY.test(value)) return undefined;
  const iso = `${value}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

export function isReviewDue(iso: string | null, now: Date): boolean {
  return iso !== null && Date.parse(iso) <= now.getTime();
}

export function reviewDateText(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(iso),
  );
}
