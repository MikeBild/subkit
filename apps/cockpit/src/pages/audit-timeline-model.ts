import type { components } from "@/api/schema";

export type TimelineEntry = components["schemas"]["AuditEntry"] & {
  request_source?: string | null;
  origin_source?: string | null;
  execution_source?: string | null;
  correlation_id?: string | null;
  changes?: Array<{
    field: string;
    before: string | number | boolean | null;
    after: string | number | boolean | null;
  }>;
  api_key_id?: string | null;
  session_id?: string | null;
  recorded_api_key_id?: string | null;
  recorded_session_id?: string | null;
  access_type?: string | null;
  oauth_client_id?: string | null;
  credential_origin?: string | null;
  reason_redacted?: boolean;
};

export type AuditGroup =
  | "day"
  | "actor"
  | "access"
  | "resourceType"
  | "resource"
  | "source"
  | "executed"
  | "execution"
  | "operation"
  | "result";

export const AUDIT_GROUPS: readonly AuditGroup[] = [
  "day",
  "actor",
  "access",
  "resourceType",
  "resource",
  "source",
  "executed",
  "execution",
  "operation",
  "result",
];

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function localDateTimeInput(instant: string | null): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface UtcChoice {
  instant: string;
  offset: string;
}

export function utcChoicesForLocalInput(value: string, zone: string): UtcChoice[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return [];
  const [, year, month, day, hour, minute] = match;
  const parts = [year, month, day, hour, minute].map(Number);
  const [y, m, d, h, min] = parts;
  if (y === undefined || m === undefined || d === undefined || h === undefined || min === undefined)
    return [];
  const naive = Date.UTC(y, m - 1, d, h, min);
  if (Number.isNaN(naive)) return [];
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const choices: UtcChoice[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = new Date(naive - offset * 60_000);
    const fields = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    if (`${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}` !== value)
      continue;
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    choices.push({
      instant: candidate.toISOString(),
      offset: `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`,
    });
  }
  return choices.sort((a, b) => a.instant.localeCompare(b.instant));
}

export function utcFromLocalInput(
  value: string,
  zone = localTimeZone(),
  selected?: string,
): string | null {
  if (!value) return null;
  const choices = utcChoicesForLocalInput(value, zone);
  if (selected) return choices.some((choice) => choice.instant === selected) ? selected : null;
  return choices.length === 1 ? choices[0]!.instant : null;
}

export function auditGroupKey(entry: TimelineEntry, group: AuditGroup, zone: string): string {
  switch (group) {
    case "day": {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date(entry.ts))
          .map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
    case "actor":
      return entry.actor_id
        ? `${entry.actor_type}:${entry.actor_id}`
        : entry.actor_type || "unknown";
    case "access":
      if (entry.api_key_id) return `api_key:${entry.api_key_id}`;
      if (entry.session_id) return `session:${entry.session_id}`;
      if (entry.oauth_client_id) return `oauth_client:${entry.oauth_client_id}`;
      return entry.access_type ? `access_type:${entry.access_type}` : "unknown";
    case "resourceType":
      return entry.resource_type || "unknown";
    case "resource":
      return entry.resource_id
        ? `${entry.resource_type}:${entry.resource_id}`
        : entry.resource_type || "unknown";
    case "source":
      return entry.origin_source ?? "unknown";
    case "executed":
      return entry.execution_source ?? "unknown";
    case "execution":
      return entry.execution_id ?? "unknown";
    case "operation":
      return entry.correlation_id ?? "unknown";
    case "result":
      return entry.result || "unknown";
  }
}

export function groupLoadedAudit(
  entries: readonly TimelineEntry[],
  group: AuditGroup,
  zone: string,
): Array<{ key: string; entries: TimelineEntry[] }> {
  const ordered = [...entries].sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
  const groups: Array<{ key: string; entries: TimelineEntry[] }> = [];
  const lookup = new Map<string, (typeof groups)[number]>();
  for (const entry of ordered) {
    const key = auditGroupKey(entry, group, zone);
    let bucket = lookup.get(key);
    if (!bucket) {
      bucket = { key, entries: [] };
      lookup.set(key, bucket);
      groups.push(bucket);
    }
    bucket.entries.push(entry);
  }
  return groups;
}

export function auditInitiatingSource(entry: TimelineEntry): string | null {
  return entry.origin_source ?? null;
}

export function auditRecordedAccess(entry: TimelineEntry): {
  apiKeyId: string | null;
  sessionId: string | null;
} {
  return {
    apiKeyId: entry.api_key_id ? null : entry.recorded_api_key_id || null,
    sessionId: entry.session_id ? null : entry.recorded_session_id || null,
  };
}
