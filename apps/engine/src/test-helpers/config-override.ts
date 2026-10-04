import { getConfig, setConfigKey } from "../config/loader.ts";

function valueAt(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    root,
  );
}

export async function withConfigKey<T>(
  path: string,
  value: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = valueAt(getConfig(), path.split("."));
  await setConfigKey(path, value, { force: true });
  try {
    return await fn();
  } finally {
    await setConfigKey(path, prior ?? "", { force: true });
  }
}
