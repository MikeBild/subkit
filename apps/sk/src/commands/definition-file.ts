export async function readDefinitionFile<T>(path: string): Promise<T> {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
