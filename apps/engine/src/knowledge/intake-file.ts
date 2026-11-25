export const INTAKE_FILE_TYPES = {
  "application/pdf": "binary",
  "image/png": "binary",
  "image/jpeg": "binary",
  "image/gif": "binary",
  "image/webp": "binary",
  "text/csv": "text",
  "text/plain": "text",
  "text/markdown": "text",
  "application/json": "text",
} as const;

export type IntakeFileType = keyof typeof INTAKE_FILE_TYPES;

export const INTAKE_TEXT_BODY_MAX_CHARS = 2_000_000;

export type IntakeFileCheck =
  | { ok: true; content_type: IntakeFileType; text: string | null }
  | { ok: false; reason: "unsupported_file_type" | "content_type_mismatch" };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

const MAGIC: Record<string, (bytes: Uint8Array) => boolean> = {
  "application/pdf": (b) => startsWith(b, ascii("%PDF-")),
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
};

const ACTIVE_TEXT = /^\s*(<!doctype\s+html|<html[\s>]|<svg[\s>]|<\?xml[\s?]|<script[\s>])/i;

export function baseContentType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function checkIntakeFile(declared: string, bytes: Uint8Array): IntakeFileCheck {
  const content_type = baseContentType(declared);
  if (!Object.hasOwn(INTAKE_FILE_TYPES, content_type))
    return { ok: false, reason: "unsupported_file_type" };
  const type = content_type as IntakeFileType;
  if (INTAKE_FILE_TYPES[type] === "binary") {
    const matches = MAGIC[type];
    return matches?.(bytes)
      ? { ok: true, content_type: type, text: null }
      : { ok: false, reason: "content_type_mismatch" };
  }
  const text = decodeUtf8(bytes);
  if (text === null || text.includes("\u0000") || ACTIVE_TEXT.test(text))
    return { ok: false, reason: "content_type_mismatch" };
  if (type === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: "content_type_mismatch" };
    }
  }
  return { ok: true, content_type: type, text };
}

export function intakeFileBody(
  file: { filename: string; content_type: IntakeFileType; size_bytes: number },
  text: string | null,
): string {
  if (text !== null && text.length > 0) return text.slice(0, INTAKE_TEXT_BODY_MAX_CHARS);
  return `${file.filename} (${file.content_type}, ${file.size_bytes} bytes)`;
}
