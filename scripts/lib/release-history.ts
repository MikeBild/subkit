export type ReleaseWorkflowRun = {
  databaseId: number;
};

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
