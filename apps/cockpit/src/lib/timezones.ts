export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZones(current: string | null = null): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([...(current ? [current] : []), ...supported, "UTC"])].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function matchingTimeZones(zones: readonly string[], search: string): string[] {
  const needle = search.trim().toLowerCase().replace(/\s+/g, "_");
  if (!needle) return [...zones];
  return zones.filter((zone) => zone.toLowerCase().includes(needle));
}

export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ");
}
