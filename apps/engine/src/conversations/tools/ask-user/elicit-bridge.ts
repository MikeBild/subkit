// ask_user_* ←→ MCP elicitation form-mode mapping.
//
// The MCP `elicitation/create` form mode accepts ONLY a flat
// JSON-Schema object of primitive properties (string / number / boolean
// / enum / string-array). Each `ask_user_*` tool has a richer input
// shape; this module maps that shape down to a primitive schema for the
// request, and maps the client's accepted answer back to the output
// shape `respondElicitation` / auto-persist expects.
//
// `mapAskUserToPrimitiveSchema` returns `{ degrade: true }` when a tool
// input cannot be expressed as flat primitives — the caller then falls
// back to the DB-pause path for that one elicitation. The per-tool
// degrade decision lives HERE so there is one place to reason about it.

import type { ElicitRequestedSchema } from "../../../mcp/elicitation/bridge.ts";
import type { FormFieldDefinition } from "./form.ts";

/** Tool names that take the form-mode elicitation bridge. */
export type FormBridgeToolName =
  | "ask_user_text"
  | "ask_user_choice"
  | "ask_user_confirm"
  | "ask_user_multi"
  | "ask_user_form";

export type MapToPrimitiveResult =
  | { degrade: true }
  | { degrade: false; requestedSchema: ElicitRequestedSchema; message: string };

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/** A property entry inside the elicitation `requestedSchema`. */
type SchemaProperty = ElicitRequestedSchema["properties"][string];

/** `opt_<value>` keying for ask_user_multi boolean properties. */
const MULTI_OPT_PREFIX = "opt_";

/**
 * Map an `ask_user_*` tool input to a flat primitive `requestedSchema`
 * for an MCP form-mode elicitation. Returns `{ degrade: true }` when the
 * input cannot be expressed flatly (the caller falls back to DB-pause).
 */
export function mapAskUserToPrimitiveSchema(
  toolName: FormBridgeToolName,
  input: unknown,
): MapToPrimitiveResult {
  if (input == null || typeof input !== "object") return { degrade: true };
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case "ask_user_text": {
      const question = typeof obj.question === "string" ? obj.question : null;
      if (!question) return { degrade: true };
      const value: SchemaProperty = {
        type: "string",
        description: question,
        ...(typeof obj.placeholder === "string" ? { title: obj.placeholder } : {}),
      };
      return {
        degrade: false,
        message: question,
        requestedSchema: {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      };
    }

    case "ask_user_choice": {
      const question = typeof obj.question === "string" ? obj.question : null;
      const options = readSelectOptions(obj.options);
      if (!question || !options || options.length < 1) return { degrade: true };
      const value: SchemaProperty = {
        type: "string",
        description: question,
        enum: options.map((o) => o.value),
        enumNames: options.map((o) => o.label),
      };
      return {
        degrade: false,
        message: question,
        requestedSchema: {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      };
    }

    case "ask_user_confirm": {
      const question = typeof obj.question === "string" ? obj.question : null;
      if (!question) return { degrade: true };
      const summary = typeof obj.summary === "string" ? obj.summary : question;
      const confirmed: SchemaProperty = {
        type: "boolean",
        description: "Approve the proposed action.",
      };
      const reason: SchemaProperty = {
        type: "string",
        description: "Optional reason or feedback.",
      };
      return {
        degrade: false,
        message: summary,
        requestedSchema: {
          type: "object",
          properties: { confirmed, reason },
          required: ["confirmed"],
        },
      };
    }

    case "ask_user_multi": {
      const question = typeof obj.question === "string" ? obj.question : null;
      const options = readSelectOptions(obj.options);
      if (!question || !options || options.length < 1) return { degrade: true };
      // One flat boolean property per option — `opt_<value>` keyed.
      const properties: Record<string, SchemaProperty> = {};
      for (const o of options) {
        properties[`${MULTI_OPT_PREFIX}${o.value}`] = {
          type: "boolean",
          title: o.label,
          ...(o.description ? { description: o.description } : {}),
        };
      }
      return {
        degrade: false,
        message: question,
        requestedSchema: { type: "object", properties },
      };
    }

    case "ask_user_form": {
      const question = typeof obj.question === "string" ? obj.question : null;
      const fields = Array.isArray(obj.fields) ? (obj.fields as FormFieldDefinition[]) : null;
      if (!question || !fields || fields.length < 1) return { degrade: true };
      const properties: Record<string, SchemaProperty> = {};
      const required: string[] = [];
      for (const field of fields) {
        // Degrade on nested / non-primitive field types — `json` is a
        // free-form object buffer and `multi` is a string[] subset,
        // neither maps to a single flat primitive cleanly enough to
        // round-trip through the elicitation form. DB-pause handles them.
        if (field.type === "json" || field.type === "multi") return { degrade: true };
        const prop = mapFormFieldToPrimitive(field);
        if (!prop) return { degrade: true };
        properties[field.name] = prop;
        if (field.required === true) required.push(field.name);
      }
      return {
        degrade: false,
        message: question,
        requestedSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      };
    }
  }
}

function mapFormFieldToPrimitive(field: FormFieldDefinition): SchemaProperty | null {
  const base = { title: field.label } as const;
  switch (field.type) {
    case "text":
    case "password":
      return { type: "string", ...base };
    case "number":
      return { type: "number", ...base };
    case "boolean":
      return { type: "boolean", ...base };
    case "select": {
      const options = readSelectOptions(field.options);
      if (!options || options.length < 1) return null;
      return {
        type: "string",
        ...base,
        enum: options.map((o) => o.value),
        enumNames: options.map((o) => o.label),
      };
    }
    default:
      return null;
  }
}

function readSelectOptions(raw: unknown): SelectOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SelectOption[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ value: entry, label: entry });
      continue;
    }
    if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const value = typeof o.value === "string" ? o.value : null;
      const label = typeof o.label === "string" ? o.label : value;
      if (value && label) {
        out.push({
          value,
          label,
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        });
        continue;
      }
    }
    return null;
  }
  return out;
}

/**
 * Map an accepted elicitation `result.content` back to the output shape
 * the `ask_user_*` tool's resolve / auto-persist path expects.
 *
 * Returns `null` when the client's answer is a protocol violation that
 * cannot be honoured (see `ask_user_choice` below). `null` is the
 * decline-equivalent `checkDecline` reads as a non-answer
 * (`operator_dismissed_elicitation`), so the loop treats a bogus answer
 * the same as a dismissal rather than persisting a partial.
 */
export function mapElicitResultToAskUserOutput(
  toolName: FormBridgeToolName,
  input: unknown,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const c = content ?? {};
  switch (toolName) {
    case "ask_user_text":
      return { value: typeof c.value === "string" ? c.value : "" };

    case "ask_user_choice": {
      const value = typeof c.value === "string" ? c.value : "";
      const options = readSelectOptions(
        input && typeof input === "object" ? (input as Record<string, unknown>).options : undefined,
      );
      const optionIndex = options ? options.findIndex((o) => o.value === value) : -1;
      // A `value` outside the original options is a protocol violation:
      // the elicitation `requestedSchema` pinned `enum` to exactly these
      // values, so a client returning anything else broke the contract.
      // Returning `{ value }` would silently persist an option the user
      // never had — instead return `null`, the decline-equivalent
      // non-answer (`checkDecline` maps null → user_declined).
      return optionIndex >= 0 ? { value, option_index: optionIndex } : null;
    }

    case "ask_user_confirm": {
      const confirmed = c.confirmed === true;
      const reason = typeof c.reason === "string" && c.reason.length > 0 ? c.reason : undefined;
      return reason ? { confirmed, reason } : { confirmed };
    }

    case "ask_user_multi": {
      // Reassemble the `opt_<value>` booleans into the `string[]` subset.
      const values: string[] = [];
      for (const [key, raw] of Object.entries(c)) {
        if (raw === true && key.startsWith(MULTI_OPT_PREFIX)) {
          values.push(key.slice(MULTI_OPT_PREFIX.length));
        }
      }
      return { values };
    }

    case "ask_user_form": {
      // Pass primitive field values straight through as a {name:value}
      // map — the schema only ever carried primitives (json/multi
      // degraded earlier).
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(c)) out[key] = raw;
      return out;
    }
  }
}
