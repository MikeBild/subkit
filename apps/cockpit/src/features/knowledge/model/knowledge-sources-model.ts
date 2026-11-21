export type SourceKind = "url" | "discovered" | "file" | "text" | "bundle";

export function knowledgeWorkflowId(
  scope: string | null | undefined,
  workflowId: string | null | undefined,
): string | null {
  return scope === "workflow" && workflowId?.trim() ? workflowId : null;
}

export function sourceKind(sourceType: string): SourceKind {
  if (sourceType === "url") return "url";
  if (sourceType === "discovery_endpoint_index") return "discovered";
  if (sourceType === "inline") return "text";
  if (sourceType === "bundle" || sourceType === "seed") return "bundle";
  return "file";
}

type SourcePrimaryAction = "refresh" | "edit";

export function sourcePrimaryAction(kind: SourceKind): SourcePrimaryAction | null {
  if (kind === "url") return "refresh";
  if (kind === "text") return "edit";
  return null;
}

export type RefreshRhythm = "never" | "daily" | "weekly" | "custom";

export const REFRESH_CRON = { daily: "0 6 * * *", weekly: "0 6 * * 1" } as const;

export function refreshRhythm(strategy: string, cron: string | null | undefined): RefreshRhythm {
  if (strategy === "manual") return "never";
  if (strategy !== "scheduled") return "custom";
  const normalized = (cron ?? "").trim().replace(/\s+/g, " ");
  if (normalized === REFRESH_CRON.daily) return "daily";
  if (normalized === REFRESH_CRON.weekly) return "weekly";
  return "custom";
}

export function refreshFields(rhythm: Exclude<RefreshRhythm, "custom">): {
  refresh_strategy: "manual" | "scheduled";
  refresh_cron: string | null;
} {
  return rhythm === "never"
    ? { refresh_strategy: "manual", refresh_cron: null }
    : { refresh_strategy: "scheduled", refresh_cron: REFRESH_CRON[rhythm] };
}

export interface SourceSection {
  key: string;
  title: string;
  content: string;
  bytes: number;
}

interface Chunk {
  ordinal: number;
  title: string | null;
  path: string | null;
  content: string;
  byte_size: number;
}

export function sourceSections(chunks: readonly Chunk[]): SourceSection[] {
  const ordered = [...chunks].sort((a, b) => a.ordinal - b.ordinal);
  const sections: SourceSection[] = [];
  const byPath = new Map<string, SourceSection>();
  for (const chunk of ordered) {
    const path = chunk.path?.trim();
    if (path) {
      const known = byPath.get(path);
      if (known) {
        known.content += `\n\n${chunk.content}`;
        known.bytes += chunk.byte_size;
        continue;
      }
      const section = {
        key: `path:${path}`,
        title: chunk.title?.trim() || path,
        content: chunk.content,
        bytes: chunk.byte_size,
      };
      byPath.set(path, section);
      sections.push(section);
      continue;
    }
    const last = sections[sections.length - 1];
    if (!chunk.title?.trim() && last && !last.key.startsWith("path:")) {
      last.content += `\n\n${chunk.content}`;
      last.bytes += chunk.byte_size;
      continue;
    }
    sections.push({
      key: `chunk:${chunk.ordinal}`,
      title: chunk.title?.trim() || `#${chunk.ordinal + 1}`,
      content: chunk.content,
      bytes: chunk.byte_size,
    });
  }
  return sections;
}

export function documentUnderTitle(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const firstText = lines.findIndex((line) => line.trim() !== "");
  const lead = firstText >= 0 ? /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[firstText] ?? "") : null;
  if (lead && lead[1]?.trim().toLowerCase() === title.trim().toLowerCase())
    lines.splice(0, firstText + 1);
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join("\n")
    .replace(/^\n+/, "");
}

export interface ApiEndpoint {
  key: string;
  method: string;
  path: string;
  purpose: string;
  operation: unknown;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: string): string {
  return (
    value
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function parseDocument(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function openApiEndpoints(contents: readonly string[]): ApiEndpoint[] | null {
  const document = parseDocument(contents.join("")) ?? parseDocument(contents.join("\n\n")) ?? null;
  if (!document || !(document.openapi || document.swagger)) return null;
  const paths = record(document.paths);
  if (!paths) return null;
  const endpoints: ApiEndpoint[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const operations = record(item);
    if (!operations) continue;
    for (const method of HTTP_METHODS) {
      const operation = record(operations[method]);
      if (!operation) continue;
      endpoints.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        purpose:
          text(operation.summary) ||
          firstLine(text(operation.description)) ||
          text(operation.operationId),
        operation,
      });
    }
  }
  return endpoints;
}

export function matchesEndpoint(endpoint: ApiEndpoint, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${endpoint.method} ${endpoint.path} ${endpoint.purpose}`.toLowerCase().includes(needle);
}

export const RAW_PREVIEW_CHARACTERS = 20_000;

export function rawPreview(contents: readonly string[]): { text: string; truncated: boolean } {
  const full = contents.join("\n\n");
  return full.length > RAW_PREVIEW_CHARACTERS
    ? { text: full.slice(0, RAW_PREVIEW_CHARACTERS), truncated: true }
    : { text: full, truncated: false };
}
