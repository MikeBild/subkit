const INLINE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
  "application/pdf",
]);
const INLINE_CONTENT_PREFIXES = ["audio/", "video/"];
const SANDBOX_POLICY = "sandbox; default-src 'none'";

function baseContentType(content_type: string): string {
  return (content_type.split(";")[0] ?? "").trim().toLowerCase();
}

function asciiFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
}

export function storedContentHeaders(
  content_type: string | null | undefined,
  filename: string,
): Record<string, string> {
  const type = content_type || "application/octet-stream";
  const base = baseContentType(type);
  const inline =
    INLINE_CONTENT_TYPES.has(base) ||
    INLINE_CONTENT_PREFIXES.some((prefix) => base.startsWith(prefix));
  return {
    "content-type": type,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "x-content-type-options": "nosniff",
    ...(base === "application/pdf" ? {} : { "content-security-policy": SANDBOX_POLICY }),
  };
}

export function isTextLike(content_type: string | null | undefined): boolean {
  if (!content_type) return true;
  return (
    content_type.startsWith("text/") ||
    content_type.includes("json") ||
    content_type.includes("yaml") ||
    content_type.includes("xml") ||
    content_type.includes("x-www-form-urlencoded")
  );
}
