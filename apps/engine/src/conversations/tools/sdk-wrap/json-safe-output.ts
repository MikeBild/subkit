// Model-facing tool-output coercion for AI SDK 7.
//
// AI SDK 7 validates every tool-result against the `JSONValue` schema when it
// assembles the next step's `ModelMessage[]`. Raw tool outputs routinely carry
// non-JSON values — `Date` objects from DB rows, `undefined` fields — which
// AI SDK 6 tolerated but v7 rejects, throwing `AI_InvalidPromptError` and
// silently aborting the multi-step tool loop (the model never sees the result,
// the turn ends one step early). Confirm-before-execution flows depend on the
// loop reaching the second tool call, so this manifested as write tools never
// pausing for confirmation.
//
// `toModelOutput` is the SDK-native hook for controlling how a tool result is
// serialised for the model. Coercing through a JSON round-trip drops
// `undefined`, turns `Date` into ISO strings, and otherwise mirrors what the
// model would have seen anyway. The loop's stop conditions still read the RAW
// `output` (with its `pause` / `committed_workflow_id` markers) — those markers
// are plain strings/booleans and survive the round-trip unchanged.

import type { JSONValue } from "ai";

/** Coerce an arbitrary tool output into a JSON-safe value (Dates → ISO strings, undefined dropped). */
export function toJsonSafe(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
  } catch {
    // BigInt / circular refs / other non-serialisable payloads: fall back to a
    // string so the model still receives *something* and the prompt stays valid.
    return String(value);
  }
}

/** `toModelOutput` implementation shared by every wrapped conversation tool. */
export function jsonSafeModelOutput({ output }: { output: unknown }): {
  type: "json";
  value: JSONValue;
} {
  return { type: "json", value: toJsonSafe(output) };
}
