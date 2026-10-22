import { type InputField, type InputScalar, inputFields } from "@/lib/workflow-inputs";

export type SchemaFieldKind = "text" | "number" | "boolean" | "enum" | "group" | "list" | "json";

export type SchemaValue = string | boolean | string[] | SchemaValues;

export interface SchemaValues {
  [name: string]: SchemaValue;
}

export type SchemaProblem = "missing" | "number" | "integer" | "json";

export interface SchemaError {
  path: string;
  field: InputField;
  problem: SchemaProblem;
}

const SCALAR_ITEMS = new Set(["string", "number", "integer", "boolean"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function schemaFields(schema: Record<string, unknown> | null | undefined): InputField[] {
  return inputFields(schema ?? null);
}

export function schemaFieldKind(field: InputField): SchemaFieldKind {
  if (field.options) return "enum";
  if (field.type === "boolean") return "boolean";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "object" && field.children.length > 0) return "group";
  if (field.type === "array" && field.itemType && SCALAR_ITEMS.has(field.itemType)) return "list";
  if (field.type === "object" || field.type === "array" || field.type === "any") return "json";
  return "text";
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function fieldValue(field: InputField, value: unknown): SchemaValue {
  switch (schemaFieldKind(field)) {
    case "boolean":
      return value === true;
    case "list":
      return Array.isArray(value) ? value.map(scalarText) : [];
    case "group":
      return valuesFromInput(field.children, isRecord(value) ? value : {});
    case "json":
      return value === undefined ? "" : JSON.stringify(value, null, 2);
    default:
      return scalarText(value);
  }
}

export function valuesFromInput(
  fields: readonly InputField[],
  input: Record<string, unknown>,
): SchemaValues {
  const values: SchemaValues = {};
  for (const field of fields) values[field.name] = fieldValue(field, input[field.name]);
  return values;
}

export function initialSchemaValues(fields: readonly InputField[]): SchemaValues {
  const defaults: Record<string, unknown> = {};
  for (const field of fields)
    if (field.defaultValue !== undefined && field.defaultValue !== null)
      defaults[field.name] = field.defaultValue;
  const values = valuesFromInput(fields, defaults);
  for (const field of fields)
    if (schemaFieldKind(field) === "group" && isRecord(values[field.name]))
      values[field.name] = initialSchemaValues(field.children);
  return values;
}

type Read = { present: false } | { present: true; value: unknown } | { problem: SchemaProblem };

function readScalar(field: InputField, text: string, itemType?: string): Read {
  const trimmed = text.trim();
  if (trimmed === "") return { present: false };
  const type = itemType ?? field.type;
  if (field.options) {
    const option = field.options.find((entry: InputScalar) => String(entry) === trimmed);
    return option === undefined ? { problem: "json" } : { present: true, value: option };
  }
  if (type === "number" || type === "integer") {
    const parsed = Number(trimmed.replace(",", "."));
    if (!Number.isFinite(parsed)) return { problem: "number" };
    if (type === "integer" && !Number.isInteger(parsed)) return { problem: "integer" };
    return { present: true, value: parsed };
  }
  if (type === "boolean") return { present: true, value: trimmed === "true" };
  return { present: true, value: text };
}

function readField(field: InputField, raw: SchemaValue | undefined, errors: SchemaError[]): Read {
  const kind = schemaFieldKind(field);
  if (kind === "boolean") return { present: true, value: raw === true };
  if (kind === "group") {
    const built = collect(field.children, isRecord(raw) ? (raw as SchemaValues) : {}, errors);
    return Object.keys(built).length > 0 ? { present: true, value: built } : { present: false };
  }
  if (kind === "list") {
    const items = Array.isArray(raw) ? raw : [];
    const values: unknown[] = [];
    for (const item of items) {
      const read = readScalar(field, item, field.itemType ?? undefined);
      if ("problem" in read) return read;
      if (read.present) values.push(read.value);
    }
    return values.length > 0 ? { present: true, value: values } : { present: false };
  }
  const text = typeof raw === "string" ? raw : "";
  if (kind === "json") {
    if (text.trim() === "") return { present: false };
    try {
      return { present: true, value: JSON.parse(text) as unknown };
    } catch {
      return { problem: "json" };
    }
  }
  return readScalar(field, text);
}

function collect(
  fields: readonly InputField[],
  values: SchemaValues,
  errors: SchemaError[],
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const read = readField(field, values[field.name], errors);
    if ("problem" in read) errors.push({ path: field.path, field, problem: read.problem });
    else if (read.present) input[field.name] = read.value;
    else if (field.required) errors.push({ path: field.path, field, problem: "missing" });
  }
  return input;
}

export function buildSchemaInput(
  fields: readonly InputField[],
  values: SchemaValues,
): { input: Record<string, unknown>; errors: SchemaError[] } {
  const errors: SchemaError[] = [];
  const input = collect(fields, values, errors);
  return { input, errors };
}

export function fieldTitle(field: InputField): string {
  if (field.title) return field.title;
  const words = field.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field.name;
}
