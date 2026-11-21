export const BOOTSTRAP_PATH = "/v1/cockpit/bootstrap";
export const INTAKE_ITEMS_PATH = "/v1/intake/items";
export const INLINE_FILE_PATH = "/v1/files/inline";
export const KNOWLEDGE_SOURCES_PATH = "/v1/knowledge-sources";
export const INTAKE_FILE_PATH = "/v1/intake/items/file";
export const COMPOSER_ATTACHMENTS_PATH = "/v1/chat/composer/attachments";
export const CSRF_HEADER = "x-subkit-csrf";

function record(json: unknown): Record<string, unknown> | null {
  return json && typeof json === "object" && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : null;
}

export function parseCsrfToken(json: unknown): string | null {
  const token = record(json)?.csrf_token;
  return typeof token === "string" && token.length > 0 && token.length <= 4096 ? token : null;
}

export function parseCreatedId(json: unknown): string | null {
  const id = record(json)?.id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function isCsrfRejection(status: number, json: unknown): boolean {
  return status === 403 && record(json)?.code === "csrf_rejected";
}

export function inlineFileBody(filename: string, contentType: string, bytes: Uint8Array) {
  return {
    filename: filename.slice(0, 255),
    content_type: contentType.slice(0, 200),
    content_base64: Buffer.from(bytes).toString("base64"),
  };
}

export function intakeFileBody(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
  now: Date,
  requestId: string,
) {
  return {
    client_request_id: requestId,
    captured_at: now.toISOString(),
    ...inlineFileBody(filename, contentType, bytes),
  };
}

const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME[extension] ?? "application/octet-stream";
}

export function headerSafeName(name: string): string {
  const safe = name.replace(/["\\\r\n]/g, "_").slice(0, 255);
  return safe || "file";
}

export function multipartSource(
  boundary: string,
  file: { name: string; contentType: string; bytes: Uint8Array },
  metadata: Record<string, unknown>,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${headerSafeName(file.name)}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + file.bytes.length + tail.length);
  body.set(head, 0);
  body.set(file.bytes, head.length);
  body.set(tail, head.length + file.bytes.length);
  return body;
}
