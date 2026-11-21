import { isTextLike } from "../../files/content-type.ts";
import { isC0OrDelete, withoutCodes } from "../../utils/control-chars.ts";

export const PROMOTE_SIZE_THRESHOLD_BYTES = 25 * 1024 * 1024;

const BINARY_SNIFF_BYTES = 8192;

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
    return hasNulByte(args.bytes);
  }
  if (ct && !isTextLike(ct)) return true;
  if (hasNulByte(args.bytes)) return true;
  return !ct && args.bytes.byteLength > PROMOTE_SIZE_THRESHOLD_BYTES;
}

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

function sanitizeFilename(raw: string): string | null {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = withoutCodes(base, isC0OrDelete).trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 255);
}

export function filenameFromResponse(args: {
  content_disposition: string | null;
  url: string;
  content_type: string | null;
  step_id: string;
}): string {
  const cd = args.content_disposition ?? "";
  const ext = cd.match(/filename\*\s*=\s*(?:utf-8|iso-8859-1)''([^;]+)/i);
  if (ext?.[1]) {
    try {
      const name = sanitizeFilename(decodeURIComponent(ext[1]));
      if (name) return name;
    } catch {}
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
      if (name?.includes(".")) return name;
    }
  } catch {}
  const suffix = EXTENSION_BY_TYPE[(args.content_type ?? "").toLowerCase().split(";")[0] ?? ""];
  return `${args.step_id}-response${suffix ?? ".bin"}`;
}
