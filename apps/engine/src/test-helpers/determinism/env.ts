export type EnvOverrides = Record<string, string | undefined>;

export interface EnvHandle {
  restore(): void;
}

export const TEST_MASTER_KEY = `${"0".repeat(63)}1`;

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
