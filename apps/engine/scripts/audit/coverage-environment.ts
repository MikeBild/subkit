import { createHash } from "node:crypto";

export function coverageDatabaseUrl(
  env: Readonly<NodeJS.ProcessEnv>,
  resourceTags: readonly string[] = [],
): { url?: string; error?: string } {
  const owned = env.SUBKIT_COVERAGE_OWNED_DATABASE_URL;
  if (resourceTags.includes("db") && !owned)
    return { error: "db-tagged coverage shard requires SUBKIT_COVERAGE_OWNED_DATABASE_URL" };
  return owned ? { url: owned } : {};
}
export function coverageTestEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  databaseUrl?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_ENV: "test",
    LLM_PROVIDER: "mock",
    SKIP_DOCKER: "1",
    DATABASE_URL: databaseUrl ?? env.DATABASE_URL,
    MASTER_KEY:
      env.MASTER_KEY ?? "00000000000000000000000000000000000000000000000000000000000000aa",
  };
}

const CONTEXT_EXCLUDES = new Set([
  "HOME",
  "USERPROFILE",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SUBKIT_TEST_HOME",
  "SUBKIT_TEST_HOME_TOKEN",
  "SUBKIT_COVERAGE_DIR",
  "SUBKIT_COVERAGE_BEHAVIOR_RECEIPT",
  "SUBKIT_COVERAGE_CONCURRENCY",
]);
const valueDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export function coverageExecutionContext(
  env: Readonly<NodeJS.ProcessEnv>,
  resourceTags: readonly string[],
): Record<string, unknown> {
  return {
    version: 1,
    resource_tags: [...new Set(resourceTags)].sort(),
    env: Object.fromEntries(
      Object.entries(env)
        .filter(([key, value]) => value !== undefined && !CONTEXT_EXCLUDES.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, valueDigest(value!)]),
    ),
    cwd: "repository",
    isolated_home: true,
    deadline_ms: 300_000,
    test_timeout_ms: 120_000,
  };
}
