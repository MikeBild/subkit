export type ReleaseWorkflowRun = {
  databaseId: number;
};

/**
 * A release version is immutable once its workflow has started, regardless of
 * whether that run succeeded, failed, or was cancelled. Git tags and GitHub
 * Releases can be deleted, but the Actions history remains an independent
 * record that the version has already been used.
 */
export function releaseVersionWasUsed(raw: string): boolean {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("release workflow history response is not an array");
  }

  for (const run of parsed) {
    if (
      typeof run !== "object" ||
      run === null ||
      typeof (run as Partial<ReleaseWorkflowRun>).databaseId !== "number"
    ) {
      throw new Error("release workflow history contains an invalid run");
    }
  }

  return parsed.length > 0;
}
