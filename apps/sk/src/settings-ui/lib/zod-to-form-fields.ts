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
