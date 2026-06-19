// Tiny shared field-access helpers. Used by the dispatcher entry,
// the synthetic-result builder, and the per-kind dispatchers.

import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";

export function readString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function readEnvironment(intent: CommitIntent): "dev" | "prod" {
  const env = readString(intent.payload, "environment");
  return env === "prod" ? "prod" : "dev";
}
