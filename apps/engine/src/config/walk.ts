import type { z } from "zod";
import { ConfigSchema, type FieldMeta } from "./schema.ts";

export type LeafKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string-list"
  | "string-array"
  | "json";

export interface ConfigLeaf {
  path: string[];
  schema: z.ZodTypeAny;
  kind: LeafKind;
  meta: FieldMeta;
  description?: string;
  enumValues?: string[];
  nullable: boolean;
}

interface UnwrapResult {
  inner: z.ZodTypeAny;
  nullable: boolean;
  meta: FieldMeta;
  description?: string;
}

function readMeta(schema: z.ZodTypeAny): { meta: FieldMeta; description?: string } {
  const raw = (schema as { meta?: () => Record<string, unknown> | undefined }).meta?.();
  if (!raw) return { meta: {} };
  const { description, ...rest } = raw;
  if (typeof description === "string") {
    return { meta: rest as FieldMeta, description };
  }
  return { meta: rest as FieldMeta };
}

function unwrap(schema: z.ZodTypeAny): UnwrapResult {
  let cursor: z.ZodTypeAny = schema;
  let nullable = false;
  let meta: FieldMeta = {};
  let description: string | undefined;

  for (let guard = 0; guard < 32; guard += 1) {
    const { meta: m, description: d } = readMeta(cursor);
    meta = { ...m, ...meta };
    if (description === undefined && d !== undefined) description = d;

    const def = (cursor as { def?: { type?: string; innerType?: z.ZodTypeAny } }).def;
    if (!def) break;
    if (def.type === "default" && def.innerType) {
      cursor = def.innerType;
      continue;
    }
    if (def.type === "prefault" && def.innerType) {
      cursor = def.innerType;
      continue;
    }
    if (def.type === "optional" && def.innerType) {
      cursor = def.innerType;
      continue;
    }
    if (def.type === "nullable" && def.innerType) {
      nullable = true;
      cursor = def.innerType;
      continue;
    }
    break;
  }

  const result: UnwrapResult = { inner: cursor, nullable, meta };
  if (description !== undefined) result.description = description;
  return result;
}

function classify(inner: z.ZodTypeAny): { kind: LeafKind; enumValues?: string[] } | null {
  const def = (
    inner as {
      def?: {
        type?: string;
        entries?: Record<string, unknown>;
        element?: z.ZodTypeAny;
        options?: z.ZodTypeAny[];
        values?: unknown[];
      };
    }
  ).def;
  if (!def?.type) return null;

  switch (def.type) {
    case "string":
      return { kind: "string" };
    case "literal": {
      const values = def.values ?? [];
      if (values.every((v) => typeof v === "string")) return { kind: "string" };
      return null;
    }
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return {
        kind: "enum",
        enumValues: Object.values(def.entries ?? {}).filter(
          (v): v is string => typeof v === "string",
        ),
      };
    case "array": {
      if (!def.element) return null;
      const elementInner = unwrap(def.element).inner;
      const elementDef = (elementInner as { def?: { type?: string } }).def;
      if (elementDef?.type === "string") return { kind: "string-list" };
      if (elementDef?.type === "object") return null;
      return { kind: "string-array" };
    }
    case "union": {
      const options = def.options ?? [];
      if (options.length === 0) return null;
      const kinds = new Set<LeafKind>();
      for (const opt of options) {
        const branch = classify(unwrap(opt).inner);
        if (!branch) return null;
        kinds.add(branch.kind);
      }
      if (kinds.size === 1) return { kind: [...kinds][0]! };
      if (kinds.size === 2 && kinds.has("string") && true) {
        return { kind: "string" };
      }
      return null;
    }
    default:
      return null;
  }
}

function walk(schema: z.ZodTypeAny, prefix: string[], out: ConfigLeaf[]): void {
  const { inner, nullable, meta, description } = unwrap(schema);
  if (meta.structural) {
    if (!meta.runtimeEditable) return;
    const leaf: ConfigLeaf = {
      path: prefix,
      schema,
      kind: "json",
      meta,
      nullable,
    };
    if (description !== undefined) leaf.description = description;
    out.push(leaf);
    return;
  }
  const def = (inner as { def?: { type?: string; shape?: Record<string, z.ZodTypeAny> } }).def;

  if (def?.type === "object" && def.shape) {
    for (const [key, child] of Object.entries(def.shape)) {
      walk(child, [...prefix, key], out);
    }
    return;
  }

  const classified = classify(inner);
  if (!classified) return;

  const leaf: ConfigLeaf = {
    path: prefix,
    schema,
    kind: classified.kind,
    meta,
    nullable,
  };
  if (classified.enumValues !== undefined) leaf.enumValues = classified.enumValues;
  if (description !== undefined) leaf.description = description;
  out.push(leaf);
}

let _leavesCache: ConfigLeaf[] | null = null;

export function listConfigLeaves(): ConfigLeaf[] {
  if (_leavesCache !== null) return _leavesCache;
  const leaves: ConfigLeaf[] = [];
  const def = (ConfigSchema as { def?: { shape?: Record<string, z.ZodTypeAny> } }).def;
  const shape = def?.shape ?? {};
  for (const [key, section] of Object.entries(shape)) {
    if (key === "tenants") continue;
    walk(section, [key], leaves);
  }
  _leavesCache = leaves;
  return leaves;
}

export function leafSchemaMeta(leaf: ConfigLeaf): { default?: unknown; enum_values?: string[] } {
  const out: { default?: unknown; enum_values?: string[] } = {};
  const parsed = leaf.schema.safeParse(undefined);
  if (parsed.success && parsed.data !== undefined) {
    out.default =
      leaf.meta.secret && parsed.data !== null && parsed.data !== "" ? "***" : parsed.data;
  }
  if (leaf.enumValues !== undefined) out.enum_values = [...leaf.enumValues];
  return out;
}

export function dottedPath(leaf: ConfigLeaf): string {
  return leaf.path.join(".");
}

export function findLeafByPath(path: string | string[]): ConfigLeaf | undefined {
  const target = Array.isArray(path) ? path.join(".") : path;
  return listConfigLeaves().find((leaf) => dottedPath(leaf) === target);
}

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function setDeep(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const unsafe = path.find((segment) => UNSAFE_SEGMENTS.has(segment));
  if (unsafe !== undefined) throw new Error(`config path segment "${unsafe}" is not allowed`);
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const child = cursor[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path.at(-1)!] = value;
}
