import { createHash } from "node:crypto";

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export function decodeUpload(buffer: Buffer | Uint8Array | string): string {
  return typeof buffer === "string" ? buffer : new TextDecoder().decode(buffer);
}

export function knowledgeContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function assessSourceSize(
  content: string,
  limit: number,
): Readonly<{ kind: "within_limit" | "exceeded"; bytes: number }> {
  const bytes = Buffer.byteLength(content, "utf8");
  return { kind: bytes > limit ? "exceeded" : "within_limit", bytes };
}
