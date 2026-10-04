export type PreviewKind = "image" | "markdown" | "text" | "csv" | "pdf" | "other";

const TEXT_EXTENSIONS = ["txt", "json", "yaml", "yml", "log", "xml", "ts", "js", "sql", "toml"];

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKind(name: string, mimeType: string | null | undefined): PreviewKind {
  const type = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extension(name);
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === "text/csv" || ext === "csv") return "csv";
  if (type === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSIONS.includes(ext))
    return "text";
  if (!type && ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return "other";
}

export function fileRefusal(
  file: { name: string; type: string; size: number },
  rules: { accept?: string; maxBytes?: number },
): "type" | "size" | null {
  if (rules.maxBytes !== undefined && file.size > rules.maxBytes) return "size";
  const accept = rules.accept
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!accept || accept.length === 0) return null;
  const type = file.type.toLowerCase();
  const ext = `.${extension(file.name)}`;
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
  const header = text.split("\n")[0] ?? "";
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
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) return rows;
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.slice(0, maxRows);
}

export function formatBytes(bytes: number, locale = "de-DE"): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}
