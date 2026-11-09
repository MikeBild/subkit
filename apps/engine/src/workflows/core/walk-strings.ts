export function walkStrings(
  value: unknown,
  visit: (text: string, path: string) => void,
  path = "",
): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkStrings(entry, visit, `${path}.${index}`);
    });
    return;
  }
  if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      walkStrings(entry, visit, `${path}.${key}`);
}
