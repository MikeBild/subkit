import {
  detectPlaceholderDestinations,
  type PlaceholderTier,
} from "../destination-placeholders.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../types.ts";

export const CONNECTOR_ID = "00000000-0000-4000-8000-000000000001";

export function parse(input: unknown): WorkflowDef {
  const parsed = WorkflowDefSchema.safeParse(input);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

export function requestWith(fields: Record<string, unknown>, id = "send"): WorkflowDef {
  return parse({
    name: "t",
    steps: [
      {
        id,
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/notify",
        ...fields,
      },
    ],
  });
}

export function detect(def: WorkflowDef, tier: PlaceholderTier = "all") {
  return detectPlaceholderDestinations(def, { tier });
}
