export function extractTemplatePlaceholders(value?: string | null): string[] {
  if (!value) return [];
  return [...new Set(Array.from(value.matchAll(/\{([a-zA-Z0-9._-]+)\}/g), (match) => match[1]!))];
}
