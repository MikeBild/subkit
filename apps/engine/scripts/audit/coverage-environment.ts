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
  "SUBKIT_QUALITY_COMMIT",
  "SUBKIT_QUALITY_SHARD",
  "ACTIONS_CACHE_SERVICE_V2",
  "ACTIONS_CACHE_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "GITHUB_ACTION",
  "GITHUB_ACTION_PATH",
  "GITHUB_ACTION_REF",
  "GITHUB_ACTION_REPOSITORY",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "GITHUB_ACTOR_ID",
  "GITHUB_API_URL",
  "GITHUB_BASE_REF",
  "GITHUB_ENV",
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_GRAPHQL_URL",
  "GITHUB_HEAD_REF",
  "GITHUB_JOB",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REF_PROTECTED",
  "GITHUB_REF_TYPE",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_RETENTION_DAYS",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_WORKSPACE",
  "RUNNER_ENVIRONMENT",
  "RUNNER_NAME",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "RUNNER_TRACKING_ID",
  "RUNNER_WORKSPACE",
]);
const valueDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export function coverageExecutionContext(
  env: Readonly<NodeJS.ProcessEnv>,
  resourceTags: readonly string[],
): Record<string, unknown> {
  return {
    version: 2,
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
