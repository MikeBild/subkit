import { findPlaceholderDestinations } from "../../../workflows/destination-placeholders.ts";

type PlaceholderHintAttribute = "placeholder" | "default";

interface PlaceholderDestinationHint {
  field: string;
  attribute: PlaceholderHintAttribute;
  match: string;
}

interface StrippedAskInput {
  input: unknown;
  dropped: PlaceholderDestinationHint[];
}

const HINT_ATTRIBUTES: readonly PlaceholderHintAttribute[] = ["placeholder", "default"];

function hintIn(
  field: string,
  attribute: PlaceholderHintAttribute,
  value: unknown,
): PlaceholderDestinationHint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const hit = findPlaceholderDestinations(value, "all")[0];
  return hit ? { field, attribute, match: hit.match } : null;
}

function withoutPlaceholderHints(
  field: string,
  record: Record<string, unknown>,
  dropped: PlaceholderDestinationHint[],
): Record<string, unknown> {
  let out = record;
  for (const attribute of HINT_ATTRIBUTES) {
    const hint = hintIn(field, attribute, out[attribute]);
    if (!hint) continue;
    dropped.push(hint);
    const { [attribute]: _removed, ...rest } = out;
    void _removed;
    out = rest;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function stripPlaceholderDestinationHints(
  toolName: string,
  input: unknown,
): StrippedAskInput {
  if (!isRecord(input)) return { input, dropped: [] };
  const dropped: PlaceholderDestinationHint[] = [];
  if (toolName === "ask_user_text") {
    return { input: withoutPlaceholderHints("question", input, dropped), dropped };
  }
  if (toolName === "ask_user_form" && Array.isArray(input.fields)) {
    const fields = input.fields.map((f) => {
      if (!isRecord(f)) return f;
      const name = typeof f.name === "string" ? f.name : "";
      return withoutPlaceholderHints(name, f, dropped);
    });
    return { input: dropped.length > 0 ? { ...input, fields } : input, dropped };
  }
  return { input, dropped };
}

export function describeDroppedHints(dropped: ReadonlyArray<PlaceholderDestinationHint>): string {
  return dropped.map((d) => `${d.field}.${d.attribute}="${d.match}"`).join(", ");
}
