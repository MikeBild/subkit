export const FEEDBACK_MAX_ATTACHMENTS = 3;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const FEEDBACK_SCREENSHOT_NAME = "window-screenshot.png";

export function base64Ceiling(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
};

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface ClassifiedFeedbackFile {
  readonly content_type: string;
  readonly text: string | null;
}

export function classifyFeedbackFile(
  filename: string,
  bytes: Uint8Array,
): ClassifiedFeedbackFile | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  const content_type = EXTENSION_TYPES[extension];
  if (!content_type) return null;
  if (content_type === "image/png")
    return startsWith(bytes, PNG) ? { content_type, text: null } : null;
  if (content_type === "image/jpeg")
    return startsWith(bytes, JPG) ? { content_type, text: null } : null;
  if (content_type === "application/pdf")
    return startsWith(bytes, PDF) ? { content_type, text: null } : null;
  const text = decodeText(bytes);
  return text === null ? null : { content_type, text };
}

export function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return Uint8Array.from(Buffer.from(value, "base64"));
}
