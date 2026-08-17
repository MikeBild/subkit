export type InputSchemaSource = "declared" | "synthesized" | "none";

export interface InputField {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

/**
 * Flattens a workflow's input schema into the fields a person fills in. Only
 * the top level is offered; anything deeper is left to the chat, where the
 * whole shape can be discussed instead of guessed at through a form.
 */
export function inputFields(schema: Record<string, unknown> | null): InputField[] {
  if (!schema) return [];
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((n) => typeof n === "string") : [],
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const field = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      name,
      type: typeof field.type === "string" ? field.type : "string",
      required: required.has(name),
      description: typeof field.description === "string" ? field.description : null,
    };
  });
}

/**
 * Turns the filled-in form back into an input payload. Empty optional fields
 * are omitted rather than sent as empty strings, so a workflow sees "not
 * given" instead of "given as nothing".
 */
export function buildInput(
  fields: readonly InputField[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw.trim() === "") continue;
    input[field.name] = coerce(raw.trim(), field.type);
  }
  return input;
}

function coerce(value: string, type: string): unknown {
  if (type === "number" || type === "integer") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
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
