import {
  ChronoUnit,
  DateTimeFormatter,
  Instant,
  LocalDate,
  LocalDateTime,
  ZonedDateTime,
  ZoneId,
} from "@js-joda/core";
import "@js-joda/timezone";
import { text } from "./limits.ts";

type Options = { zone?: string; disambiguation?: "reject" | "earlier" | "later" };
function zoned(source: string, options: Options): ZonedDateTime {
  if (!options.zone) throw new Error("An explicit IANA zone is required");
  const zone = ZoneId.of(text(options.zone));
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(source)) return Instant.parse(text(source)).atZone(zone);
  const local = LocalDateTime.parse(text(source));
  const offsets = zone.rules().validOffsets(local);
  if (offsets.length !== 1 && (!options.disambiguation || options.disambiguation === "reject"))
    throw new Error("Ambiguous or nonexistent local time; choose disambiguation");
  if (offsets.length === 2)
    return ZonedDateTime.ofLocal(
      local,
      zone,
      offsets[options.disambiguation === "later" ? 1 : 0] ?? null,
    );
  if (offsets.length === 0) {
    const transition = zone.rules().transition(local);
    if (!transition) throw new Error("Missing timezone transition");
    const seconds = transition.duration().seconds();
    return ZonedDateTime.ofLocal(
      local.plusSeconds(options.disambiguation === "earlier" ? -seconds : seconds),
      zone,
      null,
    );
  }
  return ZonedDateTime.ofLocal(local, zone, offsets[0] ?? null);
}
const units = {
  days: ChronoUnit.DAYS,
  months: ChronoUnit.MONTHS,
  years: ChronoUnit.YEARS,
  hours: ChronoUnit.HOURS,
  minutes: ChronoUnit.MINUTES,
  seconds: ChronoUnit.SECONDS,
};
export const date = Object.freeze({
  parse(source: string, options: Options = {}) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(source))
      return { kind: "date", value: LocalDate.parse(text(source)).toString() };
    const value = zoned(source, options);
    return {
      kind: "datetime",
      value: value.toString(),
      instant: value.toInstant().toString(),
      zone: value.zone().id(),
    };
  },
  format(source: string, pattern: string, options: Options = {}) {
    const formatter = DateTimeFormatter.ofPattern(text(pattern));
    return /^\d{4}-\d{2}-\d{2}$/.test(source)
      ? LocalDate.parse(text(source)).format(formatter)
      : zoned(source, options).format(formatter);
  },
  add(source: string, amount: number, unit: keyof typeof units, options: Options = {}) {
    if (!Number.isSafeInteger(amount) || !Object.hasOwn(units, unit))
      throw new Error("Invalid date amount or unit");
    return /^\d{4}-\d{2}-\d{2}$/.test(source)
      ? LocalDate.parse(text(source)).plus(amount, units[unit]).toString()
      : zoned(source, options).plus(amount, units[unit]).toOffsetDateTime().toString();
  },
  startOf(source: string, unit: "day" | "month" | "year", options: Options = {}) {
    let value = /^\d{4}-\d{2}-\d{2}$/.test(source)
      ? LocalDate.parse(text(source))
      : zoned(source, options).toLocalDate();
    if (unit === "month") value = value.withDayOfMonth(1);
    else if (unit === "year") value = value.withDayOfYear(1);
    else if (unit !== "day") throw new Error("Unsupported startOf unit");
    return value.toString();
  },
  convertZone(source: string, zone: string, options: Options = {}) {
    if (!options.zone && !/[zZ]$|[+-]\d\d:\d\d$/.test(source))
      throw new Error("Local conversion requires an explicit source zone");
    return zoned(source, { ...options, zone: options.zone ?? zone })
      .withZoneSameInstant(ZoneId.of(text(zone)))
      .toOffsetDateTime()
      .toString();
  },
});
