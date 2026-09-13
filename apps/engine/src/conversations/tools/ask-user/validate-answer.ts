// Server-side validation of an elicitation answer against the
// originating ask_user_* input declaration.
//
// The renderers validate client-side (FormPrompt pins JSON parse
// errors, TextPrompt tests validation_regex before submit), but the
// HTTP respond route and the MCP-native bridge accept arbitrary
// payloads — without this check an invalid answer flows into
// auto-persist / the next LLM turn. Validation failure does NOT
// resolve the row: the elicitation stays `pending`, which IS the
// re-prompt (no new row, no state-machine change). The caller maps the
// failure to a 422 (HTTP), a re-posted form (chat), or one bridge
// retry (MCP).
//
// Decline/cancel answers are never validated — an operator saying "no"
// (confirmed:false / declined:true) must always get through.

import { type FormFieldDefinition, validateFormFieldValue } from "./form.ts";
import { interpretConfirmDecision } from "./interpret-confirm.ts";

export interface ElicitationFieldError {
  name: string;
  message: string;
}

export type ValidateAnswerResult =
  { ok: true } | { ok: false; field_errors: ElicitationFieldError[] };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isDecline(output: Record<string, unknown>): boolean {
  return interpretConfirmDecision(output) === "declined";
}

/** Read the answered value map for ask_user_form. The DB-pause portal
 *  sends `{ values: {...} }`; the MCP bridge resolves the flat map. */
function formValues(output: Record<string, unknown>): Record<string, unknown> {
  const wrapped = asRecord(output.values);
  return wrapped ?? output;
}

export function validateElicitationAnswer(
  tool_name: string,
  input: unknown,
  output: unknown,
): ValidateAnswerResult {
  const inputObj = asRecord(input);
  const outputObj = asRecord(output);
  if (!inputObj || !outputObj) return { ok: true };
  if (isDecline(outputObj)) return { ok: true };

  switch (tool_name) {
    case "ask_user_form": {
      const fields = Array.isArray(inputObj.fields)
        ? (inputObj.fields as FormFieldDefinition[])
        : [];
      if (fields.length === 0) return { ok: true };
      const values = formValues(outputObj);
      const field_errors: ElicitationFieldError[] = [];
      for (const field of fields) {
        if (!field || typeof field.name !== "string") continue;
        const value = values[field.name];
        const missing =
          value === undefined ||
          value === null ||
          (typeof value === "string" && value.trim() === "");
        if (missing) {
          if (field.required === true) {
            field_errors.push({
              name: field.name,
              message: `${field.label ?? field.name} is required`,
            });
          }
          continue;
        }
        const invalid = validateFormFieldValue(field, value);
        if (invalid) field_errors.push({ name: field.name, message: invalid.message });
      }
      return field_errors.length > 0 ? { ok: false, field_errors } : { ok: true };
    }

    case "ask_user_text": {
      const regex =
        typeof inputObj.validation_regex === "string" ? inputObj.validation_regex : null;
      if (!regex) return { ok: true };
      // Portal sends `{ text }`; the MCP bridge maps to `{ value }`.
      const answer =
        typeof outputObj.text === "string"
          ? outputObj.text
          : typeof outputObj.value === "string"
            ? outputObj.value
            : null;
      if (answer === null) return { ok: true };
      let re: RegExp;
      try {
        re = new RegExp(regex);
      } catch {
        // An invalid LLM-authored regex passes open — never block the
        // operator on a malformed pattern.
        return { ok: true };
      }
      return re.test(answer)
        ? { ok: true }
        : { ok: false, field_errors: [{ name: "text", message: `answer must match ${regex}` }] };
    }

    case "ask_user_choice": {
      const options = Array.isArray(inputObj.options) ? inputObj.options : [];
      const allowed = new Set(
        options
          .map((o) =>
            typeof o === "string" ? o : ((asRecord(o)?.value as string | undefined) ?? null),
          )
          .filter((v): v is string => typeof v === "string"),
      );
      if (allowed.size === 0) return { ok: true };
      const value = typeof outputObj.value === "string" ? outputObj.value : null;
      if (value === null) return { ok: true };
      return allowed.has(value)
        ? { ok: true }
        : {
            ok: false,
            field_errors: [
              { name: "value", message: `"${value}" is not one of the offered options` },
            ],
          };
    }

    case "ask_user_multi": {
      const options = Array.isArray(inputObj.options) ? inputObj.options : [];
      const allowed = new Set(
        options
          .map((o) =>
            typeof o === "string" ? o : ((asRecord(o)?.value as string | undefined) ?? null),
          )
          .filter((v): v is string => typeof v === "string"),
      );
      const values = Array.isArray(outputObj.values) ? outputObj.values : null;
      if (values === null) return { ok: true };
      const field_errors: ElicitationFieldError[] = [];
      if (allowed.size > 0) {
        for (const v of values) {
          if (typeof v !== "string" || !allowed.has(v)) {
            field_errors.push({
              name: "values",
              message: `"${String(v)}" is not one of the offered options`,
            });
          }
        }
      }
      const min = typeof inputObj.min === "number" ? inputObj.min : null;
      const max = typeof inputObj.max === "number" ? inputObj.max : null;
      if (min !== null && values.length < min) {
        field_errors.push({
          name: "values",
          message: `select at least ${min} option${min === 1 ? "" : "s"}`,
        });
      }
      if (max !== null && values.length > max) {
        field_errors.push({
          name: "values",
          message: `select at most ${max} option${max === 1 ? "" : "s"}`,
        });
      }
      return field_errors.length > 0 ? { ok: false, field_errors } : { ok: true };
    }

    case "ask_user_confirm": {
      // A confirm answer must carry a recognizable decision. Declines
      // already short-circuited above (isDecline), so reaching here with
      // anything other than an explicit confirm means the client sent an
      // ambiguous payload (e.g. `{}` or an unknown key). Reject it so the
      // row stays pending and the client re-prompts, rather than letting
      // it silently resolve as a `user_declined` non-confirmation.
      if (interpretConfirmDecision(outputObj) !== "confirmed") {
        return {
          ok: false,
          field_errors: [
            {
              name: "confirmed",
              message: "confirm answer must set confirmed (or approved) to true or false",
            },
          ],
        };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}
