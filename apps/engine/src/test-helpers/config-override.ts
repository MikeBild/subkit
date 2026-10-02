// One config key, changed for the length of one call.
//
// Engine config is a process-wide singleton, and a suite that sets a key in
// `beforeAll` leaves it set for everything else that runs in the process until
// its `afterAll` — background work of other suites included. This helper keeps
// the change as narrow as it can be: the key holds the value only while `fn`
// runs, and what was there before is put back whether `fn` returns or throws.

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
    // An unset optional string leaf reads as undefined and is written as "".
    await setConfigKey(path, prior ?? "", { force: true });
  }
}
