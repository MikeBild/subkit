import { redactWithMaxDepth } from "@shared/redaction.ts";

const MAX_DEPTH = 4;

export function redact(input: unknown, depth = 0): unknown {
  return redactWithMaxDepth(input, MAX_DEPTH, depth);
}
