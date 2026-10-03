// How a knowledge source reads in the cockpit: what kind it is, and what it
// holds — the pages of an address or the documents of a bundle, each one
// section a reader can open.

/** The kinds a reader tells apart: read from an address, uploaded, typed in, imported. */
export type SourceKind = "url" | "file" | "text" | "bundle";

/** The engine's `source_type`, as the kind a reader recognises. */
export function sourceKind(sourceType: string): SourceKind {
  if (sourceType === "url") return "url";
  if (sourceType === "inline") return "text";
  if (sourceType === "bundle" || sourceType === "seed") return "bundle";
  return "file";
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

/**
 * The stored chunks, grouped into what a reader calls a page: the chunks of
 * one path (a bundle file, a page of an address) are one section; without
 * paths, each titled chunk starts a section and untitled ones continue it.
 */
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

/**
 * A document shown on a record's page sits under the page's one h1: a leading
 * heading that only repeats the record's name is dropped, and every other
 * heading moves one level down, so a document's `# Titel` never becomes a
 * second h1. Fenced code is left as written.
 */
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
