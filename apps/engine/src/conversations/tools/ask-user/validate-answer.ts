import { type SafeRegex, safeRegex, UnsafeRegexError } from "../../../utils/safe-regex.ts";
import { APPROVAL_WITH_CHANGE_MESSAGE, approvalChange } from "./confirm-change.ts";
import { type FormFieldDefinition, validateFormFieldValue } from "./form.ts";
import { interpretConfirmDecision } from "./interpret-confirm.ts";

interface ElicitationFieldError {
  name: string;
  message: string;
}

type ValidateAnswerResult = { ok: true } | { ok: false; field_errors: ElicitationFieldError[] };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isDecline(output: Record<string, unknown>): boolean {
  return interpretConfirmDecision(output) === "declined";
}

function formValues(output: Record<string, unknown>): Record<string, unknown> {
  const wrapped = asRecord(output.values);
  return wrapped ?? output;
}

const PARTIAL_SELECTION_MESSAGE = "a partial approval must select at least one change";

function missesPartialSelection(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): boolean {
  if (input.kind !== "partial_diff_approval" || output.partial !== true) return false;
  const total = Array.isArray(input.diffs) ? input.diffs.length : 0;
  const selected = Array.isArray(output.approved_indices) ? output.approved_indices : [];
  return !selected.some((index) => Number.isInteger(index) && index >= 0 && index < total);
}

export function validateElicitationAnswer(
  tool_name: string,
  input: unknown,
  output: unknown,
  reason?: string | null,
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
      const answer =
        typeof outputObj.text === "string"
          ? outputObj.text
          : typeof outputObj.value === "string"
            ? outputObj.value
            : null;
      if (answer === null) return { ok: true };
      let re: SafeRegex;
      try {
        re = safeRegex(regex);
      } catch (error) {
        if (error instanceof UnsafeRegexError && error.reason !== "invalid")
          return { ok: false, field_errors: [{ name: "text", message: error.message }] };
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
      if (missesPartialSelection(inputObj, outputObj)) {
        return {
          ok: false,
          field_errors: [{ name: "approved_indices", message: PARTIAL_SELECTION_MESSAGE }],
        };
      }
      return approvalChange(inputObj, outputObj, reason) === null
        ? { ok: true }
        : {
            ok: false,
            field_errors: [{ name: "confirmed", message: APPROVAL_WITH_CHANGE_MESSAGE }],
          };
    }

    default:
      return { ok: true };
  }
}
