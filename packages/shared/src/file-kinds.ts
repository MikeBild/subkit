export type FileKind = "image" | "pdf" | "csv" | "md" | "text";
export type PreviewKind = "image" | "markdown" | "text" | "csv" | "pdf" | "other";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTENSIONS = ["txt", "json", "yaml", "yml", "log", "xml", "ts", "js", "sql", "toml"];
const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const BYTE_STEP = 1024;

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string): FileKind {
  const ext = extOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ext === "pdf" || ext === "csv" || ext === "md") return ext;
  return "text";
}

export function previewKind(name: string, mimeType: string | null | undefined): PreviewKind {
  const [head] = (mimeType ?? "").toLowerCase().split(";") as [string];
  const type = head.trim();
  const ext = extOf(name);
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === "text/csv" || ext === "csv") return "csv";
  if (type === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSIONS.includes(ext))
    return "text";
  if (!type && [...IMAGE_EXTENSIONS, "svg"].includes(ext)) return "image";
  return "other";
}

export function fileRefusal(
  file: { name: string; type: string; size: number },
  rules: { accept?: string; maxBytes?: number },
): "type" | "size" | null {
  if (file.size > (rules.maxBytes ?? Number.POSITIVE_INFINITY)) return "size";
  const accept = rules.accept
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!accept || accept.length === 0) return null;
  const type = file.type.toLowerCase();
  const ext = `.${extOf(file.name)}`;
  const ok = accept.some((entry) =>
    entry.startsWith(".")
      ? entry === ext
      : entry.endsWith("/*")
        ? type.startsWith(entry.slice(0, -1))
        : entry === type,
  );
  return ok ? null : "type";
}

export function parseCsv(text: string, maxRows = 20): string[][] {
  const rows: string[][] = [];
  const [header] = text.split("\n") as [string];
  const delimiter = header.split(";").length > header.split(",").length ? ";" : ",";
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      row.push(cell);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) return rows;
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function csvPreview(text: string, maxRows: number): { rows: string[][]; total: number } {
  const all = parseCsv(text, Number.POSITIVE_INFINITY);
  return { rows: all.slice(0, maxRows), total: all.length };
}

export function formatBytes(bytes: number, locale: string): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    unit += 1;
  }
  // Stryker disable next-line EqualityOperator: EQ-BYTES-TEN: exactly ten shows as 10 with or without one decimal
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  return `${number} ${BYTE_UNITS[unit]}`;
}
