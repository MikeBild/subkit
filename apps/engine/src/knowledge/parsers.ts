// File format dispatch for Knowledge Sources.
//
// Delegates to existing parsers for text formats (JSON, YAML, CSV, XML,
// Markdown) and returns RawChunk[] — the same type the fingerprinting
// pipeline expects.
//
// Binary formats (PDF, DOCX, XLSX) are planned but not yet supported.
// Callers should validate MIME/extension before calling.

import type { RawChunk } from "../docs-ingestion/types.ts";

export type ParsedFormat =
  | "json"
  | "yaml"
  | "csv"
  | "xml"
  | "markdown"
  | "plaintext"
  | "openapi"
  | "unknown";

export class UnsupportedFileFormatError extends Error {
  readonly format: string;
  constructor(format: string) {
    super(`Unsupported file format for knowledge ingestion: ${format}`);
    this.name = "UnsupportedFileFormatError";
    this.format = format;
  }
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
  }

  // Fall back to MIME type
  if (mime) {
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
  }
}

/**
 * Split markdown on heading boundaries (H1 or H2).
 */
function parseMarkdownChunks(content: string, filename: string): RawChunk[] {
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
    const headingMatch = line.match(/^(#{1,2})\s+(.+)/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[2]!.trim();
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
