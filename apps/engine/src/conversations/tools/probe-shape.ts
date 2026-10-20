import { enumerateScopePaths } from "../../workflows/scope-shape.ts";

const SECRET_FIELD =
  /(?:authorization|cookie|password|secret|(?:api|access|refresh|private)[_-]?key|(?:api|access|refresh|id)[_-]?token)/i;
const SECRET_VALUE = /^(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{12,})/i;
const MAX_PATHS = 64;
const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 120;

export type ProbeResponseMode = "shape" | "sample" | "full";

function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path
    .replace(/\[\*\]/g, "[0]")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "")
    .split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}

function example(value: unknown, path: string): unknown {
  if (SECRET_FIELD.test(path)) return "[redacted]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[redacted]";
    return value.slice(0, MAX_EXAMPLE_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

export function summarizeProbeBody(value: unknown, mode: "shape" | "sample") {
  const paths = enumerateScopePaths(value, { depth_budget: 5, path_budget: MAX_PATHS });
  const fields = paths.map((path) => {
    const found = atPath(value, path);
    const descriptor: Record<string, unknown> = { path, type: kind(found) };
    if (mode === "sample") {
      const sampled = Array.isArray(found)
        ? found.slice(0, MAX_EXAMPLES).map((item) => example(item, path))
        : example(found, path);
      if (sampled !== undefined) descriptor.example = sampled;
    }
    return descriptor;
  });
  return { fields, field_limit_reached: fields.length === MAX_PATHS };
}
