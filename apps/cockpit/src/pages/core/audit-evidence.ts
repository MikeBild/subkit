import type { TranslationKey } from "@/lib/i18n";

export type AuditEvidenceBlock = { kind: "before" | "after"; text: string };
export type AuditMetadataFact = { key: string; label: string; value: string; href: string | null };
export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
export type MetadataAdapter = {
  references: Readonly<
    Record<string, { label: TranslationKey; open: TranslationKey; href(id: string): string }>
  >;
  values: Readonly<Record<string, TranslationKey>>;
};
export type AuditDetailFact = {
  label: string;
  value: string | null;
  mono?: boolean;
  prominent?: boolean;
  help?: string;
};
type CatalogFactLabel = { text: string; machine: boolean };
export type AuditDetailAdapter<Entry> = {
  result(entry: Entry): CatalogFactLabel | null;
  actor(entry: Entry): CatalogFactLabel | null;
  resource(entry: Entry): CatalogFactLabel | null;
  reason(entry: Entry): CatalogFactLabel | null;
};

function snapshot(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return Number.isFinite(value) ? String(value) : null;
}
function recordedText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}
function labelFact(label: string, value: CatalogFactLabel | null): AuditDetailFact {
  return value
    ? { label, value: value.text, ...(value.machine ? { mono: true } : {}) }
    : { label, value: null };
}

export function auditEvidenceBlocks(entry: {
  before?: unknown;
  after?: unknown;
}): AuditEvidenceBlock[] {
  const blocks: AuditEvidenceBlock[] = [];
  for (const kind of ["before", "after"] as const)
    if (entry[kind] !== null && entry[kind] !== undefined)
      blocks.push({ kind, text: snapshot(entry[kind]) });
  return blocks;
}

export function auditMetadataFacts(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  t: Translate,
  adapter: MetadataAdapter,
): { facts: AuditMetadataFact[]; rest: string | null } {
  const facts: AuditMetadataFact[] = [],
    rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const text = scalar(value),
      reference = adapter.references[key];
    if (reference && text) {
      facts.push({
        key,
        label: t(reference.label),
        value: `${t(reference.open)} · ${text}`,
        href: reference.href(text),
      });
      continue;
    }
    const label = adapter.values[key];
    if (label && text) {
      facts.push({ key, label: t(label), value: text, href: null });
      continue;
    }
    rest[key] = value;
  }
  return { facts, rest: Object.keys(rest).length ? snapshot(rest) : null };
}

export function auditDetailFacts<
  Entry extends {
    ts: string;
    actor_id: string | null;
    resource_id: string | null;
    trace_id: string | null;
    ip: string | null;
    user_agent: string | null;
    id: string;
  },
>(
  entry: Entry,
  t: Translate,
  dateTime: (value: string | Date) => string,
  labels: AuditDetailAdapter<Entry>,
): AuditDetailFact[] {
  return [
    { label: t("audit.column.time"), value: dateTime(entry.ts) },
    labelFact(t("audit.column.result"), labels.result(entry)),
    labelFact(t("audit.column.actor"), labels.actor(entry)),
    { label: t("audit.detail.actorId"), value: recordedText(entry.actor_id), mono: true },
    labelFact(t("audit.column.resource"), labels.resource(entry)),
    { label: t("audit.detail.resourceId"), value: recordedText(entry.resource_id), mono: true },
    labelFact(t("audit.column.reason"), labels.reason(entry)),
    {
      label: t("audit.detail.trace"),
      value: recordedText(entry.trace_id),
      mono: true,
      prominent: true,
      help: t("audit.detail.traceHelp"),
    },
    { label: t("audit.detail.ip"), value: recordedText(entry.ip), mono: true },
    { label: t("audit.detail.userAgent"), value: recordedText(entry.user_agent), mono: true },
    { label: t("audit.detail.record"), value: recordedText(entry.id), mono: true },
  ];
}

export function auditObjectName(
  entry: { resource_type: string; resource_id: string | null; resource_name?: string | null },
  resourceLabel: (resourceType: string) => string,
): string {
  if (entry.resource_name?.trim()) return entry.resource_name.trim();
  const type = resourceLabel(entry.resource_type);
  const id = entry.resource_id?.trim();
  return id ? `${type} · ${id}` : type;
}
