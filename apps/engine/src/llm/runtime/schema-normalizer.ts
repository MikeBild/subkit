import { stripPropertyNames } from "@shared/json-schema.ts";

interface NormalizedSchema {
  schema: Record<string, unknown>;
  wrappedInResult: boolean;
}

const SHAPE_KEYS = new Set([
  "type",
  "properties",
  "items",
  "oneOf",
  "anyOf",
  "allOf",
  "const",
  "enum",
  "$ref",
  "not",
]);

function isShapeless(node: Record<string, unknown>): boolean {
  for (const key of Object.keys(node)) {
    if (SHAPE_KEYS.has(key)) return false;
  }
  return true;
}

function cleanNode(node: unknown, isRoot: boolean): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;

  if (!isRoot && isShapeless(n)) {
    return { type: "string" };
  }

  const out: Record<string, unknown> = { ...n };
  if (Array.isArray(out.oneOf)) {
    if (Array.isArray(out.anyOf)) {
    } else {
      out.anyOf = out.oneOf;
      delete out.oneOf;
    }
  }

  if (out.type === "object" || out.type === "array") {
    out.additionalProperties = false;
    delete out.patternProperties;

    if (out.properties && typeof out.properties === "object") {
      const props = out.properties as Record<string, unknown>;
      const cleanedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        cleanedProps[key] = cleanNode(value, false);
      }
      out.properties = cleanedProps;
    }

    if (out.items) {
      out.items = cleanNode(out.items, false);
      delete out.minItems;
      delete out.maxItems;
    }
  }

  for (const combiner of ["anyOf", "allOf"] as const) {
    if (Array.isArray(out[combiner])) {
      out[combiner] = (out[combiner] as unknown[]).map((sub) => cleanNode(sub, false));
    }
  }

  if (isRoot && out.type === "array") {
    return {
      type: "object",
      properties: { result: out },
      required: ["result"],
      additionalProperties: false,
    };
  }

  return out;
}

export function normalizeSchema(schema: Record<string, unknown>): NormalizedSchema {
  const cleaned = cleanNode(stripPropertyNames(schema), true) as Record<string, unknown>;
  const wrappedInResult =
    (schema as { type?: unknown }).type === "array" && cleaned.type === "object";
  return { schema: cleaned, wrappedInResult };
}

export function unwrapResult<T>(value: unknown, wrapped: boolean): T {
  if (!wrapped) return value as T;
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return (value as { result: T }).result;
  }
  return value as T;
}
