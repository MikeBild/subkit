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
  | "zip"
  | "gzip"
  | "unknown";

export class UnsupportedFileFormatError extends Error {
  readonly format: string;
  constructor(format: string) {
    super(`Unsupported file format for knowledge ingestion: ${format}`);
    this.name = "UnsupportedFileFormatError";
    this.format = format;
  }
}

export function isBinaryFormat(format: ParsedFormat): format is BinaryFormat {
  return isBinaryFormatId(format);
}

export function detectFormat(filename: string, mime?: string): ParsedFormat {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

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
    case "zip":
      return "zip";
    case "gz":
    case "gzip":
      return "gzip";
  }

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
    if (mime.includes("gzip")) return "gzip";
    if (mime.includes("zip")) return "zip";
    if (mime.includes("json")) return "json";
    if (mime.includes("yaml") || mime.includes("yml")) return "yaml";
    if (mime.includes("csv") || mime.includes("tab-separated")) return "csv";
    if (mime.includes("xml")) return "xml";
    if (mime.includes("markdown")) return "markdown";
    if (mime.includes("text/plain")) return "plaintext";
  }

  return "unknown";
}

export function parseFileToChunks(
  content: string,
  filename: string,
  format: ParsedFormat,
): RawChunk[] {
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
      return parsePlaintextChunks(content, filename);
    case "pdf":
    case "docx":
    case "xlsx":
    case "xls":
    case "pptx":
    case "zip":
    case "gzip":
      return [];
  }
}

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
    case "zip":
    case "gzip": {
      const chunks = parseMarkdownChunks(parsed.text, filename);
      if (chunks.length === 0 || parsed.text.trim().length === 0) {
        return [];
      }
      return chunks;
    }
  }
}

export function parseMarkdownChunks(content: string, filename: string): RawChunk[] {
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

  if (chunks.length === 0) {
    return [{ title: filename, path: filename, content }];
  }

  return chunks;
}

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
