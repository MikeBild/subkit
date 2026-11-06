import type { JSONValue } from "ai";

function toJsonSafe(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
  } catch {
    return String(value);
  }
}

export function jsonSafeModelOutput({ output }: { output: unknown }): {
  type: "json";
  value: JSONValue;
} {
  return { type: "json", value: toJsonSafe(output) };
}
