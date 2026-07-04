// Scoped process.env overrides for tests.
//
// `withTestEnv` snapshots the requested keys, applies overrides,
// returns a `restore` handle. Wrap the whole thing in try/finally —
// keys the test never touched are left alone.

export type EnvOverrides = Record<string, string | undefined>;

export interface EnvHandle {
  restore(): void;
}

export function withTestEnv(overrides: EnvOverrides): EnvHandle {
  const snapshot = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    snapshot.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return {
    restore() {
      for (const [key, value] of snapshot) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

/** Run `fn` with the given env overrides; restore on exit even if `fn`
 *  throws. Returns `fn`'s result. */
export async function runWithTestEnv<T>(
  overrides: EnvOverrides,
  fn: () => Promise<T> | T,
): Promise<T> {
  const handle = withTestEnv(overrides);
  try {
    return await fn();
  } finally {
    handle.restore();
  }
}
