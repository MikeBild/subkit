import type { components } from "@cli-core/engine-api/openapi";
import { type FileKind, fileKindOf } from "@shared/file-kinds.ts";
import type { Tone } from "@ui/atoms/pill";
import type {
  ApiEndpoint,
  SourceSection,
} from "@/features/knowledge/model/knowledge-sources-model";
import { computeLineDiff } from "@/lib/line-diff";
import { entryGroupKey } from "./inbox-bulk";

type IntakeItem = components["schemas"]["IntakeItem"];
type IntakeSnapshot = components["schemas"]["IntakeItemSnapshot"];
type IntakeProposal = components["schemas"]["IntakeProposal"];
type KnowledgeSource = components["schemas"]["KnowledgeSource"];
type Skill = components["schemas"]["Skill"];
type StoredFile = components["schemas"]["File"] & {
  usage?: { workflows: number; conversations: number };
};

export function matches(q: string, ...texts: (string | null | undefined)[]): boolean {
  const n = q.trim().toLocaleLowerCase();
  return !n || texts.some((t) => (t ?? "").toLocaleLowerCase().includes(n));
}

export function groupBy<T>(items: readonly T[], key: ((x: T) => string) | null): [string, T[]][] {
  if (!key) return [["", [...items]]];
  const m = new Map<string, T[]>();
  for (const it of items) {
    const g = key(it);
    m.set(g, [...(m.get(g) ?? []), it]);
  }
  return [...m.entries()];
}

export function relTime(iso: string, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const min = Math.round((new Date(iso).getTime() - now) / 60000);
  if (Math.abs(min) < 60) return rtf.format(Math.min(-1, min), "minute");
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  return rtf.format(Math.round(hr / 24), "day");
}

export function lineDiff(from: string, to: string): { added: string[]; removed: string[] } {
  const lines = computeLineDiff(from.split("\n"), to.split("\n"));
  return {
    added: lines.filter((l) => l.type === "added" && l.text.trim()).map((l) => l.text),
    removed: lines.filter((l) => l.type === "removed" && l.text.trim()).map((l) => l.text),
  };
}

export type EntryStatus = "collected" | "review" | "accepted" | "rejected";
export type Origin = "browser" | "assistant" | "note";
export const ENTRY_TONE: Record<EntryStatus, Tone> = {
  collected: "info",
  review: "warning",
  accepted: "success",
  rejected: "neutral",
};
const ENTRY_STATUS: Record<IntakeItem["state"], EntryStatus> = {
  collected: "collected",
  reviewing: "review",
  admitted: "accepted",
  discarded: "rejected",
};

export interface Suggestion {
  proposalId: string;
  revision: number;
  digest: string;
  kind: "skill" | "source";
  title: string;
  tags: string[];
  content: string;
}

export interface EntryView {
  id: string;
  title: string;
  body: string;
  origin: Origin;
  from: string;
  url: string | null;
  category: string;
  status: EntryStatus;
  created: string;
  suggestion: Suggestion | null;
  result: { kind: "skill" | "source"; id: string } | null;
  attachment: EntryAttachment | null;
  state: IntakeItem["state"];
  source: "clip" | "note" | "session";
  version: number;
  group: string | null;
}

export interface EntryAttachment {
  fileId: string;
  name: string;
  kind: FileKind;
  size: number;
  ready: boolean;
}

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const filesApiId = (id: string): string => (BARE_UUID.test(id) ? `fid_${id}` : id);

export function entryAttachment(item: unknown): EntryAttachment | null {
  const raw = (item as { attachment?: unknown } | null)?.attachment;
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.file_id !== "string" || typeof a.filename !== "string") return null;
  return {
    fileId: filesApiId(a.file_id),
    name: a.filename,
    kind: fileKindOf(a.filename),
    size: typeof a.size_bytes === "number" ? a.size_bytes : 0,
    ready: a.status === undefined || a.status === "ready",
  };
}

export function entryOrigin(snapshot: Pick<IntakeSnapshot, "origin">): Origin {
  return snapshot.origin === "note"
    ? "note"
    : snapshot.origin === "session"
      ? "assistant"
      : "browser";
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function suggestionFor(
  itemId: string,
  proposals: readonly IntakeProposal[],
): Suggestion | null {
  const p = [...proposals]
    .filter((x) => x.status === "draft" && x.revision.items.some((i) => i.id === itemId))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!p) return null;
  const target = p.revision.target;
  const skill = "skill" in target;
  const tags = skill
    ? (target.skill.new?.tags ?? target.skill.domains ?? [])
    : "name" in target
      ? (target.tags ?? [])
      : [];
  return {
    proposalId: p.id,
    revision: p.current_revision,
    digest: p.revision.digest,
    kind: skill ? "skill" : "source",
    title: p.revision.title,
    tags,
    content: p.revision.body,
  };
}

export function entryView(item: IntakeItem, proposals: readonly IntakeProposal[]): EntryView {
  const snap = item.original_snapshot;
  const origin = entryOrigin(snap);
  const url = "source_url" in snap && snap.source_url ? snap.source_url : null;
  const from =
    snap.origin === "session"
      ? snap.client || snap.agent || ""
      : url
        ? host(url)
        : (snap.source_author ?? "");
  const status = ENTRY_STATUS[item.state];
  const result =
    item.admitted_target_id && item.admitted_target_kind
      ? {
          kind: item.admitted_target_kind === "skill" ? ("skill" as const) : ("source" as const),
          id: item.admitted_target_id,
        }
      : null;
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    origin,
    from,
    url,
    category: item.category,
    status,
    created: item.created_at,
    suggestion:
      status === "collected" || status === "review" ? suggestionFor(item.id, proposals) : null,
    result,
    attachment: entryAttachment(item),
    state: item.state,
    source: snap.origin === "session" || snap.origin === "note" ? snap.origin : "clip",
    version: item.version,
    group: entryGroupKey(item),
  };
}

export const isOpenEntry = (e: Pick<EntryView, "status">) =>
  e.status === "collected" || e.status === "review";

export function entryStrip(e: Pick<EntryView, "status" | "result">): {
  tone: Tone;
  key: "accepted" | "rejected" | "review" | "collected";
  action: "openResult" | "review" | null;
} {
  if (e.status === "accepted")
    return { tone: "success", key: "accepted", action: e.result ? "openResult" : null };
  if (e.status === "rejected") return { tone: "neutral", key: "rejected", action: null };
  if (e.status === "review") return { tone: "warning", key: "review", action: "review" };
  return { tone: "info", key: "collected", action: null };
}

export type SourceStatus = "active" | "ingesting" | "failed" | "off";
export type SourceKindView = "url" | "file" | "text" | "collection" | "api";
export const SOURCE_TONE: Record<SourceStatus, Tone> = {
  active: "success",
  ingesting: "info",
  failed: "danger",
  off: "neutral",
};
const SOURCE_STATUS: Record<KnowledgeSource["status"], SourceStatus> = {
  active: "active",
  processing: "ingesting",
  error: "failed",
  inactive: "off",
};

export function sourceKindOf(sourceType: string, mime: string | null | undefined): SourceKindView {
  if (sourceType === "url") return "url";
  if (sourceType === "inline") return "text";
  if (sourceType === "discovery_endpoint_index" || /openapi|swagger/i.test(mime ?? ""))
    return "api";
  if (sourceType === "bundle" || sourceType === "seed") return "collection";
  return "file";
}

export interface SourceView {
  id: string;
  name: string;
  kind: SourceKindView;
  status: SourceStatus;
  category: string;
  url: string | null;
  sections: number;
  ingested: string;
  created: string;
  scheduled: boolean;
  error: string | null;
  describedBy: unknown;
}

export function sourceView(s: KnowledgeSource): SourceView {
  return {
    id: s.id,
    name: s.name,
    kind: sourceKindOf(s.source_type, s.mime_type),
    status: SOURCE_STATUS[s.status],
    category: s.category,
    url: s.source_type === "url" ? s.source_uri : null,
    sections: s.chunk_count,
    ingested: s.last_refreshed_at ?? s.updated_at,
    created: s.created_at,
    scheduled: s.refresh_strategy === "scheduled",
    error: s.last_error,
    describedBy: s.description_source,
  };
}

export type SkillStatus = "active" | "off" | "draft";
export type SkillScopeView = "chat" | "drafts" | "both";
export const SKILL_TONE: Record<SkillStatus, Tone> = {
  active: "success",
  off: "neutral",
  draft: "warning",
};
const SKILL_STATUS: Record<Skill["status"], SkillStatus> = {
  active: "active",
  archived: "off",
  draft: "draft",
};
const SKILL_SCOPE: Record<Skill["applies_to"], SkillScopeView> = {
  chat: "chat",
  authoring: "drafts",
  both: "both",
};
export const SCOPE_APPLIES: Record<SkillScopeView, Skill["applies_to"]> = {
  chat: "chat",
  drafts: "authoring",
  both: "both",
};

export interface SkillView {
  id: string;
  name: string;
  status: SkillStatus;
  binding: Skill["scope"];
  scope: SkillScopeView;
  category: string;
  version: number;
  body: string;
  changed: string;
  created: string;
  describedBy: unknown;
}

export function skillView(s: Skill): SkillView {
  return {
    id: s.id,
    name: s.title,
    status: SKILL_STATUS[s.status],
    binding: s.scope,
    scope: SKILL_SCOPE[s.applies_to],
    category: s.category,
    version: s.version,
    body: s.body,
    changed: s.updated_at,
    created: s.created_at,
    describedBy: s.description_source,
  };
}

export function skillDraftErrors(d: { name: string; body: string }): {
  name: boolean;
  body: boolean;
} {
  return { name: !d.name.trim(), body: !/[\p{L}\d]/u.test(d.body.replace(/^#.*$/gm, "")) };
}

export function skillDraftChanges(
  draft: { name: string; body: string; scope: string },
  initial: { name: string; body: string; scope: string },
): number {
  return (
    (draft.name !== initial.name ? 1 : 0) +
    (draft.body !== initial.body ? 1 : 0) +
    (draft.scope !== initial.scope ? 1 : 0)
  );
}

export function awaitingAssistantReview(
  entries: readonly Pick<EntryView, "source" | "state">[],
): number {
  return entries.filter(
    (e) => e.source === "session" && (e.state === "collected" || e.state === "reviewing"),
  ).length;
}

export type FailedRemedy = "retry" | "chat" | null;

export function failedSourceRemedy(
  primary: "refresh" | "edit" | null,
  can: { write: boolean; chat: boolean },
): FailedRemedy {
  if (primary === "refresh" && can.write) return "retry";
  return can.chat ? "chat" : null;
}

export function dropQueued<T extends { key: string; progress: number }>(
  queue: readonly T[],
  key: string,
): T[] {
  return queue.filter((r) => r.key !== key);
}

export function previewedUpload<T extends { key: string }>(
  queue: readonly T[],
  key: string | null,
): T | null {
  return queue.find((r) => r.key === key) ?? null;
}

export const MAX_FILE = 5_000_000;
export const SOURCE_EXT = ["md", "txt", "csv", "json", "html", "pdf", "docx"];

export interface FileView {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  uploaded: string;
  by: string | null;
  checksum: string | null;
  reference: string;
  usedBy: number;
  ready: boolean;
  version: number;
  category: string;
  describedBy: unknown;
}

export const shortHash = (h: string) => `sha256:${h.slice(0, 4)}…${h.slice(-4)}`;

export function fileView(f: StoredFile): FileView {
  return {
    id: f.id,
    name: f.filename,
    kind: fileKindOf(f.filename),
    size: f.size_bytes,
    uploaded: f.updated_at ?? f.created_at,
    by: f.creator_name ?? f.creator_api_key_name ?? null,
    checksum: f.sha256 ? shortHash(f.sha256) : null,
    reference: f.reference ?? `@attachment:${f.slug ?? f.filename}`,
    usedBy: f.usage?.workflows ?? 0,
    ready: f.status === "ready",
    version: f.version,
    category: f.category,
    describedBy: f.description_source,
  };
}

export interface Incoming {
  name: string;
  size: number;
  hash: string;
}
export type UploadCheck = { ok: true } | { ok: false; reason: "tooBig" | "duplicate" };

export function checkUploads(
  items: readonly Incoming[],
  existing: readonly string[],
  max = MAX_FILE,
): UploadCheck[] {
  const seen = new Set(existing);
  return items.map((i) => {
    if (i.size > max) return { ok: false, reason: "tooBig" };
    if (seen.has(i.hash)) return { ok: false, reason: "duplicate" };
    seen.add(i.hash);
    return { ok: true };
  });
}

export type SectionTarget =
  | { kind: "endpoint"; endpoint: ApiEndpoint }
  | { kind: "section"; section: SourceSection }
  | null;

export function sectionTarget(
  key: string,
  endpoints: readonly ApiEndpoint[],
  sections: readonly SourceSection[],
): SectionTarget {
  if (!key) return null;
  const endpoint = endpoints.find((e) => e.key === key);
  if (endpoint) return { kind: "endpoint", endpoint };
  const section = sections.find((x) => x.key === key);
  return section ? { kind: "section", section } : null;
}
