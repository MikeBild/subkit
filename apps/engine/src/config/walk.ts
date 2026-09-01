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
      // A bare `z.literal("")` is treated as a string leaf — used by
      // the optional-URL helper as one branch of a union.
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
      // Arrays of complex objects (a declarative
      // list of server records) are STRUCTURAL config, set via the
      // config file + boot reconcile, not scalar settings-panel leaves.
      // Returning null drops them from listConfigLeaves so the settings
      // GET/PUT surface, the per-leaf sweep, and the settings doc only
      // ever cover values the scalar settings API can actually round-trip.
      if (elementDef?.type === "object") return null;
      return { kind: "string-array" };
    }
    case "union": {
      // Union of literals + string subtypes (the optionalUrl pattern,
      // and the "" | min(32) pattern for auth.session.secret). Walk
      // each branch; if every branch resolves to "string"-ish, treat
      // the union as a string leaf. Mixed-kind unions are not
      // supported and return null so the walker drops them — caught
      // by the schema-walk test in apps/sk/src/settings-ui.
      const options = def.options ?? [];
      if (options.length === 0) return null;
      const kinds = new Set<LeafKind>();
      for (const opt of options) {
        const branch = classify(unwrap(opt).inner);
        if (!branch) return null;
        kinds.add(branch.kind);
      }
      if (kinds.size === 1) return { kind: [...kinds][0]! };
      // String-ish union: literal("") + string-with-refinement → string.
      if (
        kinds.size === 2 &&
        kinds.has("string") &&
        // both still string-shaped, just different refinements
        true
      ) {
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
    // Structural records remain excluded by default. A schema may opt one
    // complete value into the validated runtime settings surface explicitly;
    // this keeps arrays such as auth.providers atomic and prevents partial,
    // invalid records from being persisted field-by-field.
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
  // Walk every section in the top-level config object.
  // The `tenants` record is excluded: tenant overlays are walked separately.
  const def = (ConfigSchema as { def?: { shape?: Record<string, z.ZodTypeAny> } }).def;
  const shape = def?.shape ?? {};
  for (const [key, section] of Object.entries(shape)) {
    if (key === "tenants") continue;
    walk(section, [key], leaves);
  }
  _leavesCache = leaves;
  return leaves;
}

export function dottedPath(leaf: ConfigLeaf): string {
  return leaf.path.join(".");
}

export function findLeafByPath(path: string | string[]): ConfigLeaf | undefined {
  const target = Array.isArray(path) ? path.join(".") : path;
  return listConfigLeaves().find((leaf) => dottedPath(leaf) === target);
}
