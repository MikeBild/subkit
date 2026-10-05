import { type PluralKey, pluralKey, type TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const NUMBER = /^\d{1,2}$/;
const STEP = /^\*\/(\d{1,2})$/;

const clock = (hour: string, minute: string) =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

function interval(t: Translate, key: PluralKey, count: number): string {
  return t(pluralKey(key, count), { count });
}

function weekday(day: number, localeTag: string): string {
  return new Intl.DateTimeFormat(localeTag, { weekday: "long", timeZone: "UTC" }).format(
    Date.UTC(2025, 5, 1 + (day % 7)),
  );
}

export function cronWords(cron: string, t: Translate, localeTag: string): string {
  const expression = cron.trim();
  const every = /^every:(\d+)$/.exec(expression);
  if (every) {
    const seconds = Number(every[1]);
    if (seconds % 3600 === 0) return interval(t, "cron.everyHours", seconds / 3600);
    if (seconds % 60 === 0) return interval(t, "cron.everyMinutes", seconds / 60);
    return interval(t, "cron.everySeconds", seconds);
  }
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) return expression;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  if (month !== "*") return expression;

  const anyDay = dayOfMonth === "*" && dayOfWeek === "*";
  const minuteStep = STEP.exec(minute);
  if (minuteStep && hour === "*" && anyDay)
    return interval(t, "cron.everyMinutes", Number(minuteStep[1]));
  const hourStep = STEP.exec(hour);
  if (hourStep && minute === "0" && anyDay)
    return interval(t, "cron.everyHours", Number(hourStep[1]));
  if (!NUMBER.test(minute)) return expression;
  if (hour === "*" && anyDay) return t("cron.hourly", { minute: minute.padStart(2, "0") });
  if (!NUMBER.test(hour)) return expression;

  const time = clock(hour, minute);
  if (anyDay) return t("cron.daily", { time });
  if (dayOfMonth === "*") {
    if (dayOfWeek === "1-5") return t("cron.weekdays", { time });
    if (NUMBER.test(dayOfWeek) && Number(dayOfWeek) <= 7)
      return t("cron.weekly", { day: weekday(Number(dayOfWeek), localeTag), time });
    return expression;
  }
  if (dayOfWeek === "*" && NUMBER.test(dayOfMonth))
    return t("cron.monthly", { day: Number(dayOfMonth), time });
  return expression;
}
