import { gunzipSync } from "node:zlib";
import { walkZipEntries } from "../../utils/zip-walk.ts";
import {
  type BinaryFormat,
  BinaryParseError,
  DetectionPriority,
  type FileParsingStrategy,
  PARSER_TIMEOUT_MS,
  withParserTimeout,
} from "./strategy.ts";

export interface ArchiveEntry {
  path: string;
  format: string;
}

export interface ArchiveSkip {
  path: string;
  reason: string;
}

export interface ArchiveParseOutput {
  format: "zip" | "gzip";
  text: string;
  entries: ArchiveEntry[];
  skipped: ArchiveSkip[];
}

export const ARCHIVE_MAX_ENTRIES = 200;
export const ARCHIVE_MAX_PER_ENTRY_BYTES = 25 * 1024 * 1024;
export const ARCHIVE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const ARCHIVE_MAX_DEPTH = 2;

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function shouldSkipDocEntry(path: string): string | null {
  if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return "macos_metadata";
  const base = path.split("/").pop() ?? path;
  if (base === ".DS_Store" || base === "Thumbs.db") return "os_metadata";
  return null;
}

export interface ArchiveDeps {
  detect(buffer: Buffer): Promise<BinaryFormat | null>;
  parse(buffer: Buffer, format: BinaryFormat): Promise<unknown>;
  render(parsed: unknown): string;
}

interface Section {
  path: string;
  format: string;
  text: string;
}

interface Collected {
  sections: Section[];
  skipped: ArchiveSkip[];
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

async function collectEntry(
  deps: ArchiveDeps,
  path: string,
  buffer: Buffer,
  depth: number,
  out: Collected,
): Promise<void> {
  const format = await deps.detect(buffer);
  if (format === "zip" || format === "gzip") {
    if (depth >= ARCHIVE_MAX_DEPTH) {
      out.skipped.push({ path, reason: "nested_archive_depth" });
      return;
    }
    const nested =
      format === "zip"
        ? await collectZip(deps, buffer, depth + 1)
        : await collectGzip(deps, buffer, depth + 1);
    out.sections.push(...nested.sections.map((s) => ({ ...s, path: `${path}!${s.path}` })));
    out.skipped.push(...nested.skipped.map((s) => ({ ...s, path: `${path}!${s.path}` })));
    return;
  }
  if (format !== null) {
    try {
      const parsed = await deps.parse(buffer, format);
      out.sections.push({ path, format, text: deps.render(parsed) });
    } catch (err) {
      out.skipped.push({
        path,
        reason: `parse_failed:${err instanceof BinaryParseError ? (err.format ?? format) : format}`,
      });
    }
    return;
  }
  try {
    out.sections.push({ path, format: "text", text: strictUtf8.decode(buffer) });
  } catch {
    out.skipped.push({ path, reason: "undecodable_binary" });
  }
}

async function collectZip(deps: ArchiveDeps, buffer: Buffer, depth: number): Promise<Collected> {
  let walked: Awaited<ReturnType<typeof walkZipEntries>>;
  try {
    walked = await walkZipEntries(buffer, {
      maxEntries: ARCHIVE_MAX_ENTRIES,
      maxPerEntryBytes: ARCHIVE_MAX_PER_ENTRY_BYTES,
      maxTotalBytes: ARCHIVE_MAX_TOTAL_BYTES,
      shouldSkip: shouldSkipDocEntry,
    });
  } catch (err) {
    throw new BinaryParseError("zip", "zip: failed to open archive", { cause: err });
  }
  const out: Collected = {
    sections: [],
    skipped: Object.entries(walked.skipped_reasons).flatMap(([reason, count]) =>
      Array.from({ length: count }, () => ({ path: "(walk)", reason })),
    ),
  };
  if (walked.truncated) out.skipped.push({ path: "(walk)", reason: "truncated_by_caps" });
  for (const entry of walked.entries) {
    await collectEntry(deps, entry.path, entry.buffer, depth, out);
  }
  return out;
}

async function collectGzip(deps: ArchiveDeps, buffer: Buffer, depth: number): Promise<Collected> {
  let inner: Buffer;
  try {
    inner = gunzipSync(buffer, { maxOutputLength: ARCHIVE_MAX_TOTAL_BYTES });
  } catch (err) {
    throw new BinaryParseError("gzip", "gzip: failed to decompress", { cause: err });
  }
  const out: Collected = { sections: [], skipped: [] };
  await collectEntry(deps, "content", inner, depth, out);
  return out;
}

function toOutput(format: "zip" | "gzip", collected: Collected): ArchiveParseOutput {
  return {
    format,
    text: collected.sections.map((s) => `## ${s.path}\n\n${s.text.trim()}`).join("\n\n"),
    entries: collected.sections.map((s) => ({ path: s.path, format: s.format })),
    skipped: collected.skipped,
  };
}

export function makeArchiveStrategies(deps: ArchiveDeps): {
  zipStrategy: FileParsingStrategy<ArchiveParseOutput>;
  gzipStrategy: FileParsingStrategy<ArchiveParseOutput>;
} {
  const zipStrategy: FileParsingStrategy<ArchiveParseOutput> = {
    format: "zip",
    priority: DetectionPriority.GENERIC_CONTAINER,
    canHandle(buffer: Buffer): boolean {
      return buffer.byteLength >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
    },
    async parse(buffer: Buffer): Promise<ArchiveParseOutput> {
      return withParserTimeout("zip", PARSER_TIMEOUT_MS.zip, async () =>
        toOutput("zip", await collectZip(deps, buffer, 1)),
      );
    },
  };
  const gzipStrategy: FileParsingStrategy<ArchiveParseOutput> = {
    format: "gzip",
    priority: DetectionPriority.COMPRESSED_WRAPPER,
    canHandle(buffer: Buffer): boolean {
      return buffer.byteLength >= 2 && buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1;
    },
    async parse(buffer: Buffer): Promise<ArchiveParseOutput> {
      return withParserTimeout("gzip", PARSER_TIMEOUT_MS.gzip, async () =>
        toOutput("gzip", await collectGzip(deps, buffer, 1)),
      );
    },
  };
  return { zipStrategy, gzipStrategy };
}
