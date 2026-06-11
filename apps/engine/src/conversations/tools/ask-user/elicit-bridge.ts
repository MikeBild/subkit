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

import { logger } from "../../../logging/logger.ts";
import type { ElicitRequestedSchema } from "../../elicitation-bridge.ts";
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
        ...(typeof obj.default === "string" ? { default: obj.default } : {}),
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
        ...(typeof obj.default === "string" && options.some((o) => o.value === obj.default)
          ? { default: obj.default }
          : {}),
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
  // `default` is emitted only when its runtime type matches the
  // property type. password/sensitive fields never carry one (the
  // input schema rejects it) — the type checks keep that invariant
  // even on hand-built inputs.
  switch (field.type) {
    case "text":
      return {
        type: "string",
        ...base,
        ...(typeof field.default === "string" ? { default: field.default } : {}),
      };
    case "password":
      return { type: "string", ...base };
    case "number":
      return {
        type: "number",
        ...base,
        ...(typeof field.default === "number" ? { default: field.default } : {}),
      };
    case "boolean":
      return {
        type: "boolean",
        ...base,
        ...(typeof field.default === "boolean" ? { default: field.default } : {}),
      };
    case "select": {
      const options = readSelectOptions(field.options);
      if (!options || options.length < 1) return null;
      return {
        type: "string",
        ...base,
        enum: options.map((o) => o.value),
        enumNames: options.map((o) => o.label),
        ...(typeof field.default === "string" && options.some((o) => o.value === field.default)
          ? { default: field.default }
          : {}),
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
 * Is `v` a JSON primitive the elicitation form contract permits — a
 * string, number, boolean, or null? An `elicitation/create` form
 * `requestedSchema` only ever declares primitive properties, so a
 * returned object/array is a protocol violation the mapper rejects.
 */
function isElicitationPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
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
      if (optionIndex < 0) {
        // Surface the misbehaving client in observability — otherwise an
        // out-of-enum answer resolves as a silent decline with no signal.
        logger.warn({
          module: "conversation",
          action: "elicitation.choice_out_of_enum",
          msg: "ask_user_choice elicitation returned a value outside the requested enum — treating as a decline",
          tool_name: toolName,
        });
        return null;
      }
      return { value, option_index: optionIndex };
    }

    case "ask_user_confirm": {
      // The elicitation `requestedSchema` pinned `confirmed` to a
      // boolean. A non-boolean answer is a protocol violation — mirror
      // `ask_user_choice` and return `null` (the decline-equivalent
      // non-answer) rather than silently coercing it to `false`, which
      // would negative-assert a decision the user never made.
      if (typeof c.confirmed !== "boolean") {
        // Surface the misbehaving client in observability — otherwise a
        // non-boolean answer resolves as a silent decline with no signal.
        logger.warn({
          module: "conversation",
          action: "elicitation.confirm_not_boolean",
          msg: "ask_user_confirm elicitation returned a non-boolean `confirmed` — treating as a decline",
          tool_name: toolName,
        });
        return null;
      }
      const confirmed = c.confirmed;
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
      // The `requestedSchema` only ever declared primitive properties
      // (json/multi fields degraded to DB-pause earlier in
      // `mapAskUserToPrimitiveSchema`). A compliant client therefore
      // returns only primitives. A non-compliant MCP client could return
      // a nested object/array where a primitive was declared; passing
      // that straight through would let the engine persist it onto the
      // elicitation `output` (feeding `maybeAutoPersistFromElicitation`).
      // Mirror the `ask_user_choice` / `ask_user_confirm` branches:
      // a contract violation collapses to `null`, the decline-equivalent
      // non-answer.
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(c)) {
        if (!isElicitationPrimitive(raw)) {
          logger.warn({
            module: "conversation",
            action: "elicitation.form_field_not_primitive",
            msg: "ask_user_form elicitation returned a non-primitive field value — treating as a decline",
            tool_name: toolName,
            field: key,
          });
          return null;
        }
        out[key] = raw;
      }
      return out;
    }
  }
}
