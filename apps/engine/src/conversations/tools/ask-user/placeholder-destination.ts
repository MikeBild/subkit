import { findPlaceholderDestinations } from "../../../workflows/destination-placeholders.ts";

export type PlaceholderHintAttribute = "placeholder" | "default";

export interface PlaceholderDestinationHint {
  field: string;
  attribute: PlaceholderHintAttribute;
  match: string;
}

function firstHint(
  field: string,
  attribute: PlaceholderHintAttribute,
  value: unknown,
): PlaceholderDestinationHint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const hit = findPlaceholderDestinations(value, "all")[0];
  return hit ? { field, attribute, match: hit.match } : null;
}

export function detectPlaceholderDestinationHint(
  toolName: string,
  input: unknown,
): PlaceholderDestinationHint | null {
  if (input == null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (toolName === "ask_user_text") {
    return (
      firstHint("question", "placeholder", obj.placeholder) ??
      firstHint("question", "default", obj.default)
    );
  }
  if (toolName === "ask_user_form") {
    const fields = Array.isArray(obj.fields) ? obj.fields : [];
    for (const f of fields) {
      if (f == null || typeof f !== "object") continue;
      const field = f as Record<string, unknown>;
      const name = typeof field.name === "string" ? field.name : "";
      const hint =
        firstHint(name, "placeholder", field.placeholder) ??
        firstHint(name, "default", field.default);
      if (hint) return hint;
    }
  }
  return null;
}

export function placeholderDestinationHintMessage(hint: PlaceholderDestinationHint): string {
  return `${hint.field}.${hint.attribute}: placeholder destination "${hint.match}" — destinations come from the user; ask again without the example value and describe the expected format instead.`;
}
