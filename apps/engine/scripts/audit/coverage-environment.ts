export function coverageDatabaseUrl(
  env: Readonly<NodeJS.ProcessEnv>,
  resourceTags: readonly string[] = [],
): { url?: string; error?: string } {
  const owned = env.SUBKIT_COVERAGE_OWNED_DATABASE_URL;
  if (resourceTags.includes("db") && !owned)
    return { error: "db-tagged coverage shard requires SUBKIT_COVERAGE_OWNED_DATABASE_URL" };
  return owned ? { url: owned } : {};
}
