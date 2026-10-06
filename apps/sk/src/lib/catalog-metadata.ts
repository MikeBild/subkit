export const catalogMetadataArgs = {
  description: {
    type: "string",
    description:
      'What it is for, in plain language — the assistant reads this to pick the right object. "" hands it back to automatic description.',
  },
  category: {
    type: "string",
    description:
      'Catalog block, lowercase words joined by dashes (see `sk categories list`). "" hands it back to automatic categorisation.',
  },
} as const;

export function catalogMetadataBody(args: {
  description?: string | undefined;
  category?: string | undefined;
}): Record<string, string> {
  const body: Record<string, string> = {};
  if (args.description !== undefined) body.description = args.description;
  if (args.category !== undefined) body.category = args.category;
  return body;
}

export const LIST_DESCRIPTION_WIDTH = 60;

export function shortDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > LIST_DESCRIPTION_WIDTH
    ? `${flat.slice(0, LIST_DESCRIPTION_WIDTH - 1).trimEnd()}…`
    : flat;
}
