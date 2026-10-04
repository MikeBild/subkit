import { createHash } from "node:crypto";

const LOG_LIST_CAP = 12;

export function idHashesCapped(ids: string[]): string[] {
  return ids
    .slice(0, LOG_LIST_CAP)
    .map((id) => createHash("sha256").update(id).digest("hex").slice(0, 8));
}
