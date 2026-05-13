// Zod → form-field bridge.
//
// The engine's GET /v1/settings response carries the runtime metadata
// the form needs to render every leaf:
//
//   { path, value, meta: { kind, sensitive, scope, requiresRestart,
//                          description }, enumValues? }
//
// `kind` is the field-type tag the engine emits from its own walker
// (see apps/engine/src/config/walk.ts). The CLI never re-derives the
// type — the engine is the single source of truth. This bridge maps
// `kind` to a renderable FormField the Ink components consume.

import type { SettingLeafEntry } from "../../engine-client.ts";

export type FormFieldKind =
  | "text"
  | "secret"
  | "number"
  | "bool"
  | "select"
  | "string-list"
  | "json";

export interface FormField {
  path: string;
  kind: FormFieldKind;
  value: unknown;
  enumValues?: string[];
  scope: "global" | "tenant";
  sensitive: boolean;
  requiresRestart: boolean;
  description?: string;
  source: "override" | "tenant" | "global" | "default";
}

export function leafToFormField(leaf: SettingLeafEntry): FormField {
  const kind = mapKind(leaf);
  const f: FormField = {
    path: leaf.path,
    kind,
    value: leaf.value,
    scope: leaf.meta.scope,
    sensitive: leaf.meta.sensitive,
    requiresRestart: leaf.meta.requiresRestart,
    source: leaf.meta.source,
  };
  if (leaf.meta.description) f.description = leaf.meta.description;
  // The /v1/settings list response does not currently emit
  // `enumValues` per leaf — the engine stores them in the schema.
  // Until the route ships an explicit `enum_values` field, the form
  // detects enums via `kind === "enum"` and the CLI shows them as
  // a free-text input pre-populated with the current value. The
  // engine validates the input and replies with a 422 envelope on a
  // bad enum, which the form surfaces as an inline error.
  return f;
}

function mapKind(leaf: SettingLeafEntry): FormFieldKind {
  if (leaf.meta.sensitive) return "secret";
  switch (leaf.meta.kind) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    case "enum":
      return "select";
    case "string-list":
      return "string-list";
    default:
      return "json";
  }
}
