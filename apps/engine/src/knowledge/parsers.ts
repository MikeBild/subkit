// File format dispatch for Knowledge Sources.
//
// Delegates to existing parsers for text formats (JSON, YAML, CSV, XML,
// Markdown) and returns RawChunk[] — the same type the fingerprinting
// pipeline expects.
//
// Binary formats (PDF, DOCX, XLSX/XLS, PPTX) are routed through the
// binary parser registry in `../docs-ingestion/parsers/` via the
// `parseBinaryFileToChunks` helper below. The text `parseFileToChunks`
// returns no chunks for a binary format — callers must dispatch on
// `detectFormat` and call the right helper.

import {
  type BinaryFormat,
  isBinaryFormat as isBinaryFormatId,
  PDF_PAGE_SEPARATOR,
  parseBinaryFile,
} from "../docs-ingestion/parsers/index.ts";
import type { RawChunk } from "../docs-ingestion/types.ts";

export type ParsedFormat =
  | "json"
  | "yaml"
  | "csv"
  | "xml"
  | "markdown"
  | "plaintext"
  | "openapi"
  | "pdf"
  | "docx"
  | "xlsx"
  | "xls"
  | "pptx"
  | "unknown";

export class UnsupportedFileFormatError extends Error {
  readonly format: string;
  constructor(format: string) {
    super(`Unsupported file format for knowledge ingestion: ${format}`);
    this.name = "UnsupportedFileFormatError";
    this.format = format;
  }
}

/** Type predicate narrowing a `ParsedFormat` to `BinaryFormat`. Thin
 *  wrapper over the canonical `isBinaryFormat` in
 *  `docs-ingestion/parsers/` — the binary-format membership set has a
 *  single source of truth there; this keeps the `ParsedFormat`-typed
 *  call sites in the knowledge subsystem ergonomic. */
export function isBinaryFormat(format: ParsedFormat): format is BinaryFormat {
  return isBinaryFormatId(format);
}

/**
 * Detect the format of a file from its filename and optional MIME type.
 */
export function detectFormat(filename: string, mime?: string): ParsedFormat {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  // Check extension first (more reliable than MIME for most cases)
  switch (ext) {
    case "json":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "csv":
    case "tsv":
      return "csv";
    case "xml":
      return "xml";
    case "md":
    case "markdown":
      return "markdown";
    case "txt":
    case "text":
    case "log":
      return "plaintext";
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "xlsx":
      return "xlsx";
    case "xls":
      return "xls";
    case "pptx":
      return "pptx";
  }

  // Fall back to MIME type. Binary office MIMEs (which carry
  // "openxmlformats-officedocument" / "ms-excel") are checked BEFORE
  // the generic xml branch — otherwise their `vnd.openxmlformats-…`
  // substring trips `xml` and DOCX/XLSX/PPTX uploads are misclassified.
  if (mime) {
    if (mime.includes("pdf")) return "pdf";
    if (mime.includes("wordprocessingml") || mime.includes("officedocument.wordprocessing")) {
      return "docx";
    }
    if (mime.includes("spreadsheetml") || mime.includes("officedocument.spreadsheet")) {
      return "xlsx";
    }
    if (mime.includes("ms-excel")) return "xls";
    if (mime.includes("presentationml") || mime.includes("officedocument.presentation")) {
      return "pptx";
    }
    if (mime.includes("json")) return "json";
    if (mime.includes("yaml") || mime.includes("yml")) return "yaml";
    if (mime.includes("csv") || mime.includes("tab-separated")) return "csv";
    if (mime.includes("xml")) return "xml";
    if (mime.includes("markdown")) return "markdown";
    if (mime.includes("text/plain")) return "plaintext";
  }

  return "unknown";
}

/**
 * Parse a file buffer into RawChunks suitable for the fingerprinting pipeline.
 *
 * Splits the content into sections based on the format:
 * - Markdown: split on headings
 * - JSON/YAML/XML/CSV: single chunk (the fingerprinter will split by budget)
 * - Plaintext: split on double newlines (paragraph boundaries)
 */
export function parseFileToChunks(
  content: string,
  filename: string,
  format: ParsedFormat,
): RawChunk[] {
  // Empty or whitespace-only content produces no chunks
  if (!content || content.trim().length === 0) return [];

  switch (format) {
    case "markdown":
      return parseMarkdownChunks(content, filename);
    case "json":
    case "yaml":
    case "xml":
    case "csv":
    case "openapi":
      return [{ title: filename, path: filename, content }];
    case "plaintext":
      return parsePlaintextChunks(content, filename);
    case "unknown":
      // Treat unknown as plaintext
      return parsePlaintextChunks(content, filename);
    case "pdf":
    case "docx":
    case "xlsx":
    case "xls":
    case "pptx":
      // Binary formats are dispatched via `parseBinaryFileToChunks` —
      // callers must branch on `isBinaryFormat(format)`.
      return [];
  }
}

/**
 * Parse a binary file (PDF/DOCX/XLSX/PPTX) buffer into RawChunks. Throws
 * `BinaryParseError` from the underlying parser on failure; callers
 * decide whether to surface the error or degrade to a placeholder.
 */
export async function parseBinaryFileToChunks(
  buffer: Buffer,
  filename: string,
  format: ParsedFormat,
): Promise<RawChunk[]> {
  if (!isBinaryFormat(format)) return [];
  const parsed = await parseBinaryFile(buffer, format);
  switch (parsed.format) {
    case "pdf": {
      const pages = parsed.text.split(PDF_PAGE_SEPARATOR);
      const chunks: RawChunk[] = [];
      for (let i = 0; i < pages.length; i += 1) {
        const body = (pages[i] ?? "").trim();
        if (!body) continue;
        chunks.push({
          title: `${filename} p.${i + 1}`,
          path: `${filename}#page=${i + 1}`,
          content: body,
        });
      }
      if (chunks.length === 0) {
        return [{ title: filename, path: filename, content: parsed.text }];
      }
      return chunks;
    }
    case "docx": {
      const chunks = parseMarkdownChunks(parsed.markdown, filename);
      if (chunks.length === 0) {
        return [{ title: filename, path: filename, content: parsed.markdown }];
      }
      return chunks;
    }
    case "xlsx":
    case "xls": {
      return Object.entries(parsed.sheets).map(([name, rows]) => ({
        title: `${filename} — ${name}`,
        path: `${filename}#sheet=${name}`,
        content: JSON.stringify(rows, null, 2),
      }));
    }
    case "pptx": {
      return parsed.slides.map((slide) => ({
        title: `${filename} slide ${slide.index}`,
        path: `${filename}#slide=${slide.index}`,
        content: slide.text || "(empty slide)",
      }));
    }
  }
}

/**
 * Split markdown on heading boundaries (H1 or H2). Exported so the
 * file-upload source and the DOCX binary path can share the same
 * chunking strategy without duplicating the heading walk.
 */
export function parseMarkdownChunks(content: string, filename: string): RawChunk[] {
  // Split on lines starting with # or ##
  const lines = content.split("\n");
  const chunks: RawChunk[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      chunks.push({ title: currentTitle, path: filename, content: text });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const title = line.match(/^(#{1,2})\s+(.+)/)?.[2];
    if (title !== undefined) {
      flush();
      currentTitle = title.trim();
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // If no headings found, return as single chunk
  if (chunks.length === 0) {
    return [{ title: filename, path: filename, content }];
  }

  return chunks;
}

/**
 * Split plaintext on paragraph boundaries (double newlines).
 */
function parsePlaintextChunks(content: string, filename: string): RawChunk[] {
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  if (paragraphs.length <= 1) {
    return [{ title: filename, path: filename, content }];
  }

  return paragraphs.map((p, i) => ({
    title: `${filename} §${i + 1}`,
    path: filename,
    content: p.trim(),
  }));
}
