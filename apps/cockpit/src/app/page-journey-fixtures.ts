import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Locale } from "@/lib/i18n";
import {
  ALL_PERMISSIONS,
  attention,
  BASE_ROUTES,
  bootstrapFor,
  type Handler,
  NOW,
  setup,
  TENANT,
} from "./journey-fixtures";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  minimum?: number;
  default?: unknown;
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};

type Operation = {
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

const SPEC = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../../packages/cli-core/src/engine-api/openapi.json"),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function deref(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").at(-1) ?? "";
  return deref(SPEC.components.schemas[name] ?? {});
}

function nullable(schema: Schema): boolean {
  if (schema.nullable) return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  return (schema.anyOf ?? schema.oneOf ?? []).some((option) => deref(option).type === "null");
}

const NAMED: Record<string, string> = {
  currency: "EUR",
  tz: "UTC",
  timezone: "Europe/Berlin",
};

export function sample(input: Schema, depth = 0, name = ""): unknown {
  const schema = deref(input);
  if (depth > 12) return null;
  if ("const" in schema) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (nullable(schema)) return null;
  if (schema.allOf?.length)
    return Object.assign({}, ...schema.allOf.map((part) => sample(part, depth + 1)));
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.length) return sample(options[0] ?? {}, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    const value: Record<string, unknown> = {};
    for (const key of schema.required ?? [])
      value[key] = sample(schema.properties?.[key] ?? {}, depth + 1, key);
    return value;
  }
  if (type === "array") return [];
  if (type === "string") {
    if (NAMED[name]) return NAMED[name];
    if (schema.format === "date-time") return NOW;
    if (schema.format === "date") return NOW.slice(0, 10);
    if (schema.format === "uuid") return TENANT;
    if (schema.format === "uri" || schema.format === "url") return "https://example.com";
    return "";
  }
  if (type === "number" || type === "integer") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  return null;
}

const TEMPLATES = Object.entries(SPEC.paths)
  .filter(([, operations]) => operations.get)
  .map(([template, operations]) => ({
    params: (template.match(/\{/g) ?? []).length,
    pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
    schema: operations.get?.responses?.["200"]?.content?.["application/json"]?.schema ?? null,
  }))
  .sort((left, right) => left.params - right.params);

const BASE_PATTERNS = Object.entries(BASE_ROUTES).map(
  ([key, handler]) => [new RegExp(`^${key}$`), handler] as const,
);

export function pageRoutes(
  locale: Locale,
  overrides: Record<string, Handler> = {},
): Record<string, Handler> {
  const boot = bootstrapFor(locale, ALL_PERMISSIONS);
  return {
    ...overrides,
    "GET /v1/.*": (url, init) => {
      const path = url.pathname.replace(/^\/cockpit\/i\/[^/]+\/api/, "");
      for (const [pattern, handler] of BASE_PATTERNS)
        if (pattern.test(path)) return handler(url, init);
      if (path === "/v1/cockpit/bootstrap") return boot;
      if (path === "/v1/attention") return attention;
      if (path === "/v1/identity/me/setup") return setup;
      const match = TEMPLATES.find((template) => template.pattern.test(path));
      if (match?.schema) return sample(match.schema);
      return { items: [], next_cursor: null, total: 0 };
    },
  };
}
