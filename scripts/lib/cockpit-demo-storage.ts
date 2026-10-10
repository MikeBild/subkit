const KIB_PER_GIB = 1024 * 1024;

export function dockerAvailableKiB(output: string): number {
  const rows = output.trim().split(/\r?\n/).slice(1);
  for (const row of rows) {
    const match = row.match(/^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+.+$/);
    if (!match) continue;
    const available = Number(match[1]);
    if (Number.isSafeInteger(available) && available >= 0) return available;
  }
  throw new Error("Cannot read available Docker filesystem space from df -Pk");
}

export function dockerStorageProblem(availableKiB: number, building: boolean): string | null {
  if (!Number.isSafeInteger(availableKiB) || availableKiB < 0)
    throw new Error("Docker filesystem space must be a nonnegative safe integer");
  const requiredGiB = building ? 12 : 1;
  if (availableKiB >= requiredGiB * KIB_PER_GIB) return null;
  return (
    `Docker filesystem has ${(availableKiB / KIB_PER_GIB).toFixed(2)} GiB free; ` +
    `${requiredGiB} GiB is required before ${building ? "building the demo" : "starting or seeding the demo"}. ` +
    "Free unused Docker build cache with docker builder prune, or increase the Docker Desktop disk image limit. " +
    "Free macOS host space alone does not establish Docker capacity. No existing containers, images or volumes were deleted by this check."
  );
}
