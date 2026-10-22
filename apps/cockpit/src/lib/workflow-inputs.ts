import type { TranslationKey } from "@/lib/i18n";

export type InputSchemaSource = "declared" | "synthesized" | "none";

export type InputScalar = string | number | boolean;

export interface InputField {
  name: string;
  path: string;
  type: string;
  union: readonly string[] | null;
  format: string | null;
  itemType: string | null;
  required: boolean;
  title: string | null;
  description: string | null;
  options: readonly InputScalar[] | null;
  defaultValue: unknown;
  example: unknown;
  children: InputField[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is InputScalar =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function allowedTypes(schema: Record<string, unknown>): string[] {
  const own = Array.isArray(schema.type) ? schema.type : [schema.type];
  const members = [schema.anyOf, schema.oneOf]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter(record)
    .flatMap((member) => {
      const types = allowedTypes(member);
      if (types.length > 0) return types;
      if (record(member.properties)) return ["object"];
      if (member.items !== undefined) return ["array"];
      return [];
    });
  return [
    ...new Set(
      [...own, ...members].filter(
        (entry): entry is string => typeof entry === "string" && entry !== "null",
      ),
    ),
  ];
}

function typeOf(schema: Record<string, unknown>): string {
  const types = allowedTypes(schema);
  if (types.length === 1 && types[0]) return types[0];
  if (types.length > 1) return "any";
  if (record(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "string";
}

function readField(
  name: string,
  raw: unknown,
  required: boolean,
  parent: string | null,
  depth: number,
): InputField {
  const schema = record(raw) ? raw : {};
  const type = typeOf(schema);
  const options = Array.isArray(schema.enum) ? schema.enum.filter(isScalar) : [];
  const path = parent ? `${parent}.${name}` : name;
  return {
    name,
    path,
    type,
    union: type === "any" ? allowedTypes(schema) : null,
    format: typeof schema.format === "string" ? schema.format : null,
    itemType: type === "array" && record(schema.items) ? typeOf(schema.items) : null,
    required,
    title: typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : null,
    description: typeof schema.description === "string" ? schema.description : null,
    options: options.length > 0 ? options : null,
    defaultValue: schema.default,
    example:
      Array.isArray(schema.examples) && schema.examples.length > 0
        ? schema.examples[0]
        : schema.example,
    children: type === "object" && depth < 1 ? readFields(schema, path, depth + 1) : [],
  };
}

function readFields(
  schema: Record<string, unknown>,
  parent: string | null,
  depth: number,
): InputField[] {
  if (!record(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((n) => typeof n === "string") : [],
  );
  return Object.entries(schema.properties).map(([name, raw]) =>
    readField(name, raw, required.has(name), parent, depth),
  );
}

export function inputFields(schema: Record<string, unknown> | null): InputField[] {
  return schema ? readFields(schema, null, 0) : [];
}

export type InputForm =
  | { kind: "none" }
  | { kind: "fields"; fields: InputField[] }
  | { kind: "whole"; field: InputField };

export const WHOLE_INPUT = "input";

export function inputForm(schema: Record<string, unknown> | null): InputForm {
  if (!schema || Object.keys(schema).length === 0) return { kind: "none" };
  const fields = readFields(schema, null, 0);
  if (fields.length > 0) return { kind: "fields", fields };
  if (record(schema.properties) && schema.additionalProperties !== true) return { kind: "none" };
  if (schema.additionalProperties === false) return { kind: "none" };
  return { kind: "whole", field: readField(WHOLE_INPUT, schema, false, null, 1) };
}

export function formFields(form: InputForm): InputField[] {
  return form.kind === "fields" ? form.fields : form.kind === "whole" ? [form.field] : [];
}

export function flattenInputFields(fields: readonly InputField[]): InputField[] {
  return fields.flatMap((field) => [field, ...field.children]);
}

const TYPE_KEYS: Record<string, TranslationKey> = {
  string: "input.type.string",
  number: "input.type.number",
  integer: "input.type.integer",
  boolean: "input.type.boolean",
  object: "input.type.object",
  array: "input.type.array",
  file: "input.type.file",
  null: "input.type.null",
  any: "input.type.any",
};

const FORMAT_KEYS: Record<string, TranslationKey> = {
  email: "input.type.email",
  "date-time": "input.type.dateTime",
  date: "input.type.date",
  uri: "input.type.uri",
  url: "input.type.uri",
};

export function inputTypeKey(field: Pick<InputField, "type" | "format">): TranslationKey {
  if (field.type === "string" && field.format && FORMAT_KEYS[field.format])
    return FORMAT_KEYS[field.format] as TranslationKey;
  return TYPE_KEYS[field.type] ?? "input.type.string";
}

export function inputItemTypeKey(field: Pick<InputField, "itemType">): TranslationKey | null {
  return field.itemType ? (TYPE_KEYS[field.itemType] ?? null) : null;
}

export function inputSampleText(
  field: Pick<InputField, "example" | "defaultValue">,
): string | null {
  const value = field.example ?? field.defaultValue;
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
