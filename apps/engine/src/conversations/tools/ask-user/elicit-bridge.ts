import { logger } from "../../../logging/index.ts";
import type { ElicitRequestedSchema } from "../../elicitation-bridge.ts";
import type { FormFieldDefinition } from "./form.ts";

export type FormBridgeToolName =
  | "ask_user_text"
  | "ask_user_choice"
  | "ask_user_confirm"
  | "ask_user_multi"
  | "ask_user_form";

type MapToPrimitiveResult =
  | { degrade: true }
  | { degrade: false; requestedSchema: ElicitRequestedSchema; message: string }
  | { degrade: true; sensitive: true; message: string };

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

type SchemaProperty = ElicitRequestedSchema["properties"][string];

const MULTI_OPT_PREFIX = "opt_";

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
      const hasSensitive = fields.some((f) => f.type === "password" || f.sensitive === true);
      if (hasSensitive) return { degrade: true, sensitive: true, message: question };
      const properties: Record<string, SchemaProperty> = {};
      const required: string[] = [];
      for (const field of fields) {
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
      return {
        type: "string",
        ...base,
        ...(typeof field.default === "string" ? { default: field.default } : {}),
      };
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

function isElicitationPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

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
      if (optionIndex < 0) {
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
      if (typeof c.confirmed !== "boolean") {
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
      const values: string[] = [];
      for (const [key, raw] of Object.entries(c)) {
        if (raw === true && key.startsWith(MULTI_OPT_PREFIX)) {
          values.push(key.slice(MULTI_OPT_PREFIX.length));
        }
      }
      return { values };
    }

    case "ask_user_form": {
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
