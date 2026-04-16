// File-upload source normalizer.
//
// Accepts a buffer + a hint (filename or MIME type) and returns one or
// more chunks. Supported formats: JSON, YAML, CSV, XML. PDF, DOCX, and
// XLSX are explicitly out of scope and surface as `unsupported` errors —
// no binary parsing libraries are pulled in.
//
// The implementation is deliberately library-free: we ship a small YAML
// parser (good enough for flat key/value docs) and an XML walker that
// handles the doc-style nesting needed for retrieval. CSV uses a
// streaming line splitter that respects quoted fields.

import { byteLen } from "../chunker.ts";
import type { RawChunk } from "../types.ts";

export type FileUploadFormat = "json" | "yaml" | "csv" | "xml";

export class UnsupportedFileUploadError extends Error {
  constructor(format: string) {
    super(`file-upload: ${format} is not supported by the doc ingester`);
    this.name = "UnsupportedFileUploadError";
  }
}

export interface FileUploadInput {
  buffer: Buffer | Uint8Array | string;
  filename?: string;
  mime?: string;
}

export interface FileUploadResult {
  format: FileUploadFormat;
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

const UNSUPPORTED_BINARY: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".doc": "doc",
  ".xls": "xls",
  ".ppt": "ppt",
  ".pptx": "pptx",
};

export function detectFormat(input: FileUploadInput): FileUploadFormat {
  const name = (input.filename ?? "").toLowerCase();
  for (const [ext, label] of Object.entries(UNSUPPORTED_BINARY)) {
    if (name.endsWith(ext)) throw new UnsupportedFileUploadError(label);
  }
  const mime = (input.mime ?? "").toLowerCase();
  if (mime.includes("pdf")) throw new UnsupportedFileUploadError("pdf");
  if (mime.includes("officedocument") || mime.includes("msword") || mime.includes("excel")) {
    throw new UnsupportedFileUploadError("office-binary");
  }
  if (name.endsWith(".json") || mime.includes("json")) return "json";
  if (name.endsWith(".yaml") || name.endsWith(".yml") || mime.includes("yaml")) return "yaml";
  if (name.endsWith(".csv") || mime.includes("csv")) return "csv";
  if (name.endsWith(".xml") || mime.includes("xml")) return "xml";
  throw new UnsupportedFileUploadError(name || mime || "unknown");
}

function bufferToString(b: Buffer | Uint8Array | string): string {
  if (typeof b === "string") return b;
  if (b instanceof Buffer) return b.toString("utf8");
  return Buffer.from(b).toString("utf8");
}

/** Tiny line-oriented CSV parser that respects quoted fields. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      cur.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      cur.push(field);
      field = "";
      rows.push(cur);
      cur = [];
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0]!;
  return {
    headers,
    rows: rows.slice(1).filter((r) => r.length > 0 && !(r.length === 1 && r[0] === "")),
  };
}

/** Minimal flat YAML parser: top-level `key: value` and `- item` lists. */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("- ")) {
      if (currentList && currentKey) {
        currentList.push(line.slice(2).trim());
      }
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (currentKey && currentList) {
      out[currentKey] = currentList;
      currentList = null;
    }
    if (value === "" || value === undefined) {
      currentKey = key!;
      currentList = [];
      continue;
    }
    currentKey = null;
    currentList = null;
    if (value === "true") out[key!] = true;
    else if (value === "false") out[key!] = false;
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) out[key!] = Number(value);
    else out[key!] = value.replace(/^"|"$/g, "");
  }
  if (currentKey && currentList) out[currentKey] = currentList;
  return out;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Tiny non-validating XML tokenizer good enough to walk doc-style trees. */
export function parseSimpleXml(text: string): XmlNode {
  const root: XmlNode = { name: "_root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      // Skip declarations / comments.
      if (text.startsWith("<?", i)) {
        const end = text.indexOf("?>", i);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i);
        i = end === -1 ? text.length : end + 3;
        continue;
      }
      const end = text.indexOf(">", i);
      if (end === -1) break;
      const tag = text.slice(i + 1, end);
      i = end + 1;
      if (tag.startsWith("/")) {
        stack.pop();
        continue;
      }
      const selfClose = tag.endsWith("/");
      const inner = selfClose ? tag.slice(0, -1).trim() : tag.trim();
      const spaceIdx = inner.indexOf(" ");
      const name = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
      const attrs: Record<string, string> = {};
      if (spaceIdx !== -1) {
        const attrStr = inner.slice(spaceIdx + 1);
        const re = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
        let m: RegExpExecArray | null = re.exec(attrStr);
        while (m) {
          attrs[m[1]!] = m[2]!;
          m = re.exec(attrStr);
        }
      }
      const node: XmlNode = { name, attrs, children: [], text: "" };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClose) stack.push(node);
    } else {
      const next = text.indexOf("<", i);
      const slice = text.slice(i, next === -1 ? text.length : next);
      const txt = slice.trim();
      if (txt) stack[stack.length - 1]!.text += txt;
      i = next === -1 ? text.length : next;
    }
  }
  return root;
}

function renderXmlNode(node: XmlNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const head = `${pad}<${node.name}${attrs ? ` ${attrs}` : ""}>`;
  const text = node.text ? `${pad}  ${node.text}` : "";
  const kids = node.children.map((c) => renderXmlNode(c, depth + 1));
  return [head, text, ...kids].filter(Boolean).join("\n");
}

/** Parse + chunk one uploaded file. Returns `RawChunk[]`. */
export function ingestFileUpload(input: FileUploadInput): FileUploadResult {
  const format = detectFormat(input);
  const text = bufferToString(input.buffer);
  const bytes = byteLen(text);
  const uri = input.filename ?? `inline://${format}`;
  const chunks: RawChunk[] = [];
  switch (format) {
    case "json": {
      const parsed = JSON.parse(text) as unknown;
      const pretty = JSON.stringify(parsed, null, 2);
      chunks.push({
        title: `json: ${uri}`,
        path: "json",
        content: `# ${uri}\n\n\`\`\`json\n${pretty}\n\`\`\``,
      });
      break;
    }
    case "yaml": {
      const parsed = parseSimpleYaml(text);
      const lines = Object.entries(parsed).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`);
      chunks.push({
        title: `yaml: ${uri}`,
        path: "yaml",
        content: `# ${uri}\n\n${lines.join("\n")}`,
      });
      break;
    }
    case "csv": {
      const { headers, rows } = parseCsv(text);
      chunks.push({
        title: `csv: ${uri} (header)`,
        path: "csv.header",
        content: `# ${uri}\n\ncolumns: ${headers.join(", ")}\nrows: ${rows.length}`,
      });
      // One chunk per row, capped at 200 rows for safety.
      const cap = Math.min(rows.length, 200);
      for (let i = 0; i < cap; i += 1) {
        const row = rows[i]!;
        const body = headers.map((h, idx) => `${h}: ${row[idx] ?? ""}`).join("\n");
        chunks.push({
          title: `csv row ${i + 1}`,
          path: `csv.rows.${i + 1}`,
          content: body,
        });
      }
      break;
    }
    case "xml": {
      const root = parseSimpleXml(text);
      chunks.push({
        title: `xml: ${uri}`,
        path: "xml",
        content: `# ${uri}\n\n${renderXmlNode(root)}`,
      });
      break;
    }
  }
  return { format, uri, raw_bytes: bytes, chunks };
}
