import type { TranslationKey } from "@/lib/i18n";

export type InputSchemaSource = "declared" | "synthesized" | "none";

/** A value an `enum` may list, or a default or example may carry. */
export type InputScalar = string | number | boolean;

export interface InputField {
  /** The property's own name. */
  name: string;
  /** Where it sits in the input: `address.city` for a nested field. */
  path: string;
  /** JSON Schema type; `string` when the schema names none. */
  type: string;
  /** JSON Schema `format` (`email`, `date-time`, …) or the typed `file` leaf. */
  format: string | null;
  /** The element type of an array, when the schema names one. */
  itemType: string | null;
  required: boolean;
  description: string | null;
  /** The allowed values, when the schema restricts them. */
  options: readonly InputScalar[] | null;
  /** The schema's own default; `undefined` when it has none. */
  defaultValue: unknown;
  /** The schema's own example; `undefined` when it has none. */
  example: unknown;
  /** The fields of an object, one level deep. Empty for everything else. */
  children: InputField[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is InputScalar =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function typeOf(schema: Record<string, unknown>): string {
  const type = Array.isArray(schema.type)
    ? schema.type.find((entry) => entry !== "null")
    : schema.type;
  if (typeof type === "string") return type;
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
    format: typeof schema.format === "string" ? schema.format : null,
    itemType: type === "array" && record(schema.items) ? typeOf(schema.items) : null,
    required,
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

/**
 * A JSON Schema's properties as the fields a person reads and fills in: name,
 * type, whether it is required, the allowed values, default and example, and
 * the fields of a nested object one level deep. Anything deeper is one JSON
 * value — the chat is where a whole shape is discussed rather than guessed at
 * through a form.
 *
 * The one reader behind the parameter table on the workflow page and the run
 * dialog, so the two cannot describe one input differently.
 */
export function inputFields(schema: Record<string, unknown> | null): InputField[] {
  return schema ? readFields(schema, null, 0) : [];
}

/** Every field as one table row: an object, then its own fields. */
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
};

const FORMAT_KEYS: Record<string, TranslationKey> = {
  email: "input.type.email",
  "date-time": "input.type.dateTime",
  date: "input.type.date",
  uri: "input.type.uri",
  url: "input.type.uri",
};

/** The word for a field's type; a text field with a known format names that. */
export function inputTypeKey(field: Pick<InputField, "type" | "format">): TranslationKey {
  if (field.type === "string" && field.format && FORMAT_KEYS[field.format])
    return FORMAT_KEYS[field.format] as TranslationKey;
  return TYPE_KEYS[field.type] ?? "input.type.string";
}

/** The word for an array's element type, or null when the schema names none. */
export function inputItemTypeKey(field: Pick<InputField, "itemType">): TranslationKey | null {
  return field.itemType ? (TYPE_KEYS[field.itemType] ?? null) : null;
}

/** A default or example as the reader would type it. Null when there is none. */
export function inputSampleText(
  field: Pick<InputField, "example" | "defaultValue">,
): string | null {
  const value = field.example ?? field.defaultValue;
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Which control a field is filled in with. */
export type InputControl = "text" | "number" | "boolean" | "select" | "json";

export function inputControl(field: Pick<InputField, "type" | "options">): InputControl {
  if (field.options) return "select";
  if (field.type === "number" || field.type === "integer") return "number";
  if (field.type === "boolean") return "boolean";
  if (field.type === "object" || field.type === "array") return "json";
  return "text";
}

/**
 * What the form starts with: the schema's default where it has one, so a
 * reader sees the value a run would use instead of an empty field.
 */
export function initialInputValues(fields: readonly InputField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.defaultValue === undefined || field.defaultValue === null) continue;
    values[field.name] =
      typeof field.defaultValue === "string"
        ? field.defaultValue
        : JSON.stringify(field.defaultValue);
  }
  return values;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parse(field: InputField, raw: string): Parsed {
  const text = raw.trim();
  switch (inputControl(field)) {
    case "number": {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { ok: false };
      if (field.type === "integer" && !Number.isInteger(parsed)) return { ok: false };
      return { ok: true, value: parsed };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "select": {
      const option = field.options?.find((entry) => String(entry) === text);
      return option === undefined ? { ok: false } : { ok: true, value: option };
    }
    case "json":
      try {
        const value = JSON.parse(text) as unknown;
        const fits = field.type === "array" ? Array.isArray(value) : record(value);
        return fits ? { ok: true, value } : { ok: false };
      } catch {
        return { ok: false };
      }
    default:
      return { ok: true, value: text };
  }
}

/**
 * Turns the filled-in form back into an input payload. Empty optional fields
 * are omitted rather than sent as empty strings, so a workflow sees "not
 * given" instead of "given as nothing". A value that does not fit its type is
 * left out too — `invalidInputs` names it, and the form does not submit.
 */
export function buildInput(
  fields: readonly InputField[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw.trim() === "") continue;
    const parsed = parse(field, raw);
    if (parsed.ok) input[field.name] = parsed.value;
  }
  return input;
}

/** Required fields the person has not filled in yet. */
export function missingRequired(
  fields: readonly InputField[],
  values: Readonly<Record<string, string>>,
): string[] {
  return fields
    .filter((field) => field.required && !(values[field.name] ?? "").trim())
    .map((field) => field.name);
}

/**
 * Fields whose text does not fit their type: a number that is not one, JSON
 * that does not parse, an object where a list belongs. Sending them as text
 * would hand the workflow a value of the wrong type under the right name.
 */
export function invalidInputs(
  fields: readonly InputField[],
  values: Readonly<Record<string, string>>,
): string[] {
  return fields
    .filter((field) => {
      const raw = values[field.name];
      return raw !== undefined && raw.trim() !== "" && !parse(field, raw).ok;
    })
    .map((field) => field.name);
}
