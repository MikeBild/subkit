// HTTP response → file promotion rule.
//
// Pure decision module: given a 2xx response's headers and body bytes,
// decide whether the body is a binary artefact that must be preserved
// byte-for-byte as an engine-managed file instead of being decoded to
// UTF-8 (which irreversibly mangles binary payloads into U+FFFD
// replacement chars). The persistence side effect lives with the
// workflow dispatch path (`execution/steps/request/file-output.ts`);
// this module owns only the detection rule + filename derivation so
// the HTTP driver can consult it without importing execution code.
//
// Rule set (any match promotes):
//   1. `Content-Disposition: attachment` — explicit vendor intent.
//   2. Non-text content type per `isTextLike` (image/*, application/pdf,
//      application/zip, audio, video, …). `application/octet-stream`
//      is EXCLUDED here — vendors routinely mislabel JSON as
//      octet-stream and the driver's shape sniffer must keep winning
//      for those; octet-stream promotes only when the bytes sniff as
//      binary (rule 3).
//   3. Binary sniff — a NUL byte in the first `BINARY_SNIFF_BYTES`.
//      Text encodings never contain NUL; every common binary container
//      (zip, gzip, png, pdf xref streams, protobuf) does.
//   4. Body larger than `PROMOTE_SIZE_THRESHOLD_BYTES` regardless of
//      type — payloads that size are artefacts, not step scope data.

import { isTextLike } from "../../files/content-type.ts";

/** Bodies over this size promote to a file regardless of content type. */
export const PROMOTE_SIZE_THRESHOLD_BYTES = 25 * 1024 * 1024;

/** Window scanned for the NUL-byte binary sniff. */
export const BINARY_SNIFF_BYTES = 8192;

function hasNulByte(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function isOctetStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/octet-stream");
}

export function shouldPromoteToFile(args: {
  status: number;
  content_type: string | null;
  content_disposition: string | null;
  bytes: Uint8Array;
}): boolean {
  if (args.status < 200 || args.status >= 300) return false;
  if (args.content_disposition?.toLowerCase().includes("attachment")) return true;
  const ct = args.content_type ?? "";
  if (isOctetStream(ct)) {
    // Mislabeled-JSON guard: only promote octet-stream when the bytes
    // actually sniff as binary. Text-shaped octet-stream stays on the
    // driver's parse path (shape sniffer handles JSON/CSV/XML).
    return hasNulByte(args.bytes);
  }
  // `isTextLike` returns true for an EMPTY content type — that default
  // must not be trusted here, so the empty case falls through to the
  // byte sniff instead. Any explicitly typed non-text response (pdf,
  // image, zip, vendor-custom binary) promotes.
  if (ct && !isTextLike(ct)) return true;
  if (hasNulByte(args.bytes)) return true;
  // Oversized UNTYPED bodies are artefacts. Typed text (a large JSON /
  // CSV API response) stays parseable step data regardless of size —
  // the execution payload-offload path owns that concern.
  return !ct && args.bytes.byteLength > PROMOTE_SIZE_THRESHOLD_BYTES;
}

/** Minimal content-type → extension map for the last-resort filename.
 *  Not exhaustive on purpose: the disposition / URL paths cover real
 *  vendor responses; this only prevents extension-less step fallbacks. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

/** Strip directory components, traversal, control chars; cap at the
 *  255-char ceiling the files API enforces on upload filenames. */
function sanitizeFilename(raw: string): string | null {
  const base = raw.split(/[/\\]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from vendor-supplied filenames is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 255);
}

/** RFC 6266 filename derivation: `filename*=UTF-8''…` → `filename="…"`
 *  → last URL path segment → `<step_id>-response<ext>`. */
export function filenameFromResponse(args: {
  content_disposition: string | null;
  url: string;
  content_type: string | null;
  step_id: string;
}): string {
  const cd = args.content_disposition ?? "";
  // filename*=charset''percent-encoded (RFC 6266 / RFC 8187) wins over
  // the plain filename= param when both are present.
  const ext = cd.match(/filename\*\s*=\s*(?:utf-8|iso-8859-1)''([^;]+)/i);
  if (ext?.[1]) {
    try {
      const name = sanitizeFilename(decodeURIComponent(ext[1]));
      if (name) return name;
    } catch {
      // malformed percent-encoding — fall through
    }
  }
  const plain = cd.match(/filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
  const plainRaw = plain?.[1] ?? plain?.[2];
  if (plainRaw) {
    const name = sanitizeFilename(plainRaw);
    if (name) return name;
  }
  try {
    const path = new URL(args.url).pathname;
    const segment = path.split("/").filter(Boolean).pop();
    if (segment) {
      const name = sanitizeFilename(decodeURIComponent(segment));
      // An extension-less URL segment ("/download", "/export") is a
      // route name, not a filename — prefer the typed step fallback.
      if (name?.includes(".")) return name;
    }
  } catch {
    // unparseable URL — fall through
  }
  const suffix = EXTENSION_BY_TYPE[(args.content_type ?? "").toLowerCase().split(";")[0] ?? ""];
  return `${args.step_id}-response${suffix ?? ".bin"}`;
}
