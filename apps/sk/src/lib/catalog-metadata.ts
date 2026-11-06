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

interface CatalogMetadataFlags {
  description?: string | undefined;
  category?: string | undefined;
}

export function catalogMetadataBody(args: CatalogMetadataFlags): {
  description?: string | null;
  category?: string | null;
} {
  const body: { description?: string | null; category?: string | null } = {};
  if (args.description !== undefined) body.description = args.description || null;
  if (args.category !== undefined) body.category = args.category || null;
  return body;
}

export function catalogMetadataCreate(args: CatalogMetadataFlags): {
  description?: string;
  category?: string;
} {
  return {
    ...(args.description ? { description: args.description } : {}),
    ...(args.category ? { category: args.category } : {}),
  };
}

const LIST_DESCRIPTION_WIDTH = 60;

export function shortDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > LIST_DESCRIPTION_WIDTH
    ? `${flat.slice(0, LIST_DESCRIPTION_WIDTH - 1).trimEnd()}…`
    : flat;
}
