import type { TranslationKey } from "@/lib/i18n";

export type InputSchemaSource = "declared" | "synthesized" | "none";

/** A value an `enum` may list, or a default or example may carry. */
export type InputScalar = string | number | boolean;

export interface InputField {
  /** The property's own name. */
  name: string;
  /** Where it sits in the input: `address.city` for a nested field. */
  path: string;
  /**
   * JSON Schema type; `string` when the schema names none, `any` when it
   * allows several (`anyOf`, `oneOf`, a list of types) — see `union`.
   */
  type: string;
  /** The types a field of type `any` allows. Null for a single type. */
  union: readonly string[] | null;
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

/**
 * Every type a schema allows, `null` aside: its own `type` (one or a list)
 * and the types of its `anyOf` / `oneOf` members. A field typed only through
 * `anyOf` used to read as text, and a number typed into it was sent as text.
 */
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

/** How a workflow's input is given. */
export type InputForm =
  /** The workflow takes no input. */
  | { kind: "none" }
  /** Named fields, each with its own control. */
  | { kind: "fields"; fields: InputField[] }
  /**
   * A schema that describes the input without naming fields — "an object",
   * "a list", "any of these". The whole input is one JSON value. It used to
   * read as "no input needed", and the run dialog sent none.
   */
  | { kind: "whole"; field: InputField };

/** The name the one field of a `whole` form goes by: the body's own key. */
export const WHOLE_INPUT = "input";

export function inputForm(schema: Record<string, unknown> | null): InputForm {
  if (!schema || Object.keys(schema).length === 0) return { kind: "none" };
  const fields = readFields(schema, null, 0);
  if (fields.length > 0) return { kind: "fields", fields };
  // An object that states it has no properties and allows no others takes nothing.
  if (record(schema.properties) && schema.additionalProperties !== true) return { kind: "none" };
  if (schema.additionalProperties === false) return { kind: "none" };
  // Depth 1: the whole value is edited as JSON, never split into rows.
  return { kind: "whole", field: readField(WHOLE_INPUT, schema, false, null, 1) };
}

/** The fields a form asks for: its named ones, or the one whole value. */
export function formFields(form: InputForm): InputField[] {
  return form.kind === "fields" ? form.fields : form.kind === "whole" ? [form.field] : [];
}

/**
 * The run's `input` from a filled-in form, or `undefined` when there is none
 * to send: named fields make an object, a whole value is the input itself.
 */
export function buildFormInput(form: InputForm, values: Readonly<Record<string, string>>): unknown {
  if (form.kind === "none") return undefined;
  const built = buildInput(formFields(form), values);
  return form.kind === "whole" ? built[WHOLE_INPUT] : built;
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
  any: "input.type.any",
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
  // Several types at once cannot be one typed control: the value is JSON.
  if (field.type === "object" || field.type === "array" || field.type === "any") return "json";
  return "text";
}

/** The JSON Schema type of a parsed value. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Whether a parsed value is of one of the types a union allows. */
function inUnion(value: unknown, union: readonly string[]): boolean {
  const type = jsonType(value);
  return union.includes(type) || (type === "integer" && union.includes("number"));
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
        if (field.union) return inUnion(value, field.union) ? { ok: true, value } : { ok: false };
        const fits = field.type === "array" ? Array.isArray(value) : record(value);
        return fits ? { ok: true, value } : { ok: false };
      } catch {
        // Not JSON: plain text, where the field allows text at all.
        return field.union?.includes("string") ? { ok: true, value: text } : { ok: false };
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
