import { parseXmlBody } from "../../../utils/xml-parser.ts";

function shouldSniff(contentType: string): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.includes("application/octet-stream")) return true;
  if (ct === "text/plain" || ct.startsWith("text/plain;")) return true;
  return false;
}

function sniffBodyShape(text: string): "json" | "xml" | "csv" | null {
  const sample = text.slice(0, 512).trimStart();
  if (!sample) return null;
  if (sample.startsWith("{") || sample.startsWith("[")) return "json";
  if (sample.startsWith("<?xml") || /^<[a-z_][\w:.-]*[\s>]/i.test(sample)) return "xml";
  const lines = sample.split(/\r?\n/);
  if (lines.length >= 2) {
    const header = lines[0] ?? "";
    if (header.includes(",")) {
      const cells = header.split(",");
      const looksLikeIdentifierHeader =
        cells.length >= 2 && cells.every((c) => /^[A-Za-z_][\w\-.]{0,63}$/.test(c.trim()));
      const secondLineHasContent = (lines[1] ?? "").trim().length > 0;
      if (looksLikeIdentifierHeader && secondLineHasContent) return "csv";
    }
  }
  return null;
}

function isJsonContentType(contentType: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("application/json") ||
    ct.includes("application/x-amz-json") ||
    ct.includes("application/vnd.api+json") ||
    ct.includes("application/ld+json") ||
    ct.includes("application/hal+json") ||
    /\+json(\b|;)/.test(ct)
  );
}

export function parseResponseBody(text: string, contentType: string): unknown {
  if (isJsonContentType(contentType) && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (shouldSniff(contentType) && text.length > 0) {
    const shape = sniffBodyShape(text);
    if (shape === "json") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (shape === "csv") {
      return parseCsvBody(text);
    }
    if (shape === "xml") {
      const parsed = parseXmlBody(text);
      if (parsed !== null) return parsed;
    }
  }
  return text;
}

function parseCsvBody(text: string): Array<Record<string, string>> {
  try {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cur.push(field);
          field = "";
        } else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i++;
          cur.push(field);
          rows.push(cur);
          cur = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || cur.length > 0) {
      cur.push(field);
      rows.push(cur);
    }
    if (rows.length === 0) return [];
    const header = rows[0]!;
    return rows.slice(1).map((cells) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        obj[header[i]!] = cells[i] ?? "";
      }
      return obj;
    });
  } catch {
    return [];
  }
}

export interface ResolvedFilePart {
  name: string;
  file?: {
    openRead(): Promise<AsyncIterable<Uint8Array>>;
    filename: string;
    content_type: string | null;
    size_bytes: number;
  };
  value?: string;
  filename?: string;
  content_type?: string;
}

export async function buildMultipartBody(parts: ResolvedFilePart[]): Promise<FormData> {
  const form = new FormData();
  for (const part of parts) {
    if (part.file !== undefined) {
      const f = part.file;
      const effectiveFilename = part.filename ?? f.filename;
      const effectiveContentType =
        part.content_type ?? f.content_type ?? "application/octet-stream";
      let blob: Blob;
      {
        const chunks: ArrayBuffer[] = [];
        for await (const raw of await f.openRead()) {
          const ab = raw.buffer.slice(
            raw.byteOffset,
            raw.byteOffset + raw.byteLength,
          ) as ArrayBuffer;
          chunks.push(ab);
        }
        blob = new Blob(chunks, { type: effectiveContentType });
      }
      form.append(part.name, blob, effectiveFilename);
    } else if (part.value !== undefined) {
      form.append(part.name, part.value);
    }
  }
  return form;
}
