const MAX_TEXT = 1_048_576;
export const MAX_ROWS = 10_000;
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT)
    throw new Error("Expected bounded text");
  return value;
}
export function bounded(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 64 || ++budget.nodes > 100_000) throw new Error("Structure limit exceeded");
  if (typeof value === "string") text(value);
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) bounded(child, depth + 1, budget);
  }
}
export function own(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe path");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
