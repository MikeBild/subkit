function cronNumber(value: string, maximum: number): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const number = Number(value);
  return number <= maximum ? number : null;
}

export function formatWeeklyWorkflowReviewSchedule(cron: string, locale: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") return null;
  const minute = cronNumber(fields[0] ?? "", 59);
  const hour = cronNumber(fields[1] ?? "", 23);
  const weekday = cronNumber(fields[4] ?? "", 7);
  if (minute === null || hour === null || weekday === null) return null;
  const day = weekday === 7 ? 0 : weekday;
  const date = new Date(Date.UTC(2024, 0, 7 + day, hour, minute));
  const weekdayLabel = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    date,
  );
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${weekdayLabel}, ${time}`;
}
