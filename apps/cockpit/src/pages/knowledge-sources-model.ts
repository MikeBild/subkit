import type { TranslationKey } from "@/lib/i18n";

export type SourceKind = "url" | "discovered" | "file" | "text" | "bundle";

export function sourceKind(sourceType: string): SourceKind {
  if (sourceType === "url") return "url";
  if (sourceType === "discovery_endpoint_index") return "discovered";
  if (sourceType === "inline") return "text";
  if (sourceType === "bundle" || sourceType === "seed") return "bundle";
  return "file";
}

export type SourcePrimaryAction = "refresh" | "edit";

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

export function knowledgeSummary(
  sources: number,
  sections: number | undefined,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  const count = t(sources === 1 ? "knowledge.summary.one" : "knowledge.summary.other", {
    count: sources,
  });
  if (sections === undefined || !Number.isInteger(sections) || sections < 0) return count;
  return `${count} · ${t(sections === 1 ? "knowledge.sections.one" : "knowledge.sections.other", { count: sections })}`;
}
