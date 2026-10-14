import { readFileSync } from "node:fs";

export function releaseGateContext(tag: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Invalid release tag");
  return `subkit-release/${tag}`;
}

export function assertReleaseRefsUnchanged(
  initialLocalTag: string,
  currentLocalTag: string,
  remoteTag: string,
  commit: string,
): void {
  if (
    (initialLocalTag !== "" && initialLocalTag !== commit) ||
    currentLocalTag !== initialLocalTag ||
    remoteTag !== ""
  ) {
    throw new Error("Release tag references changed during verification");
  }
}

export function assertReleaseGateStatus(raw: unknown, tag: string, commit: string): void {
  const context = releaseGateContext(tag);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid release commit");
  if (!raw || typeof raw !== "object") throw new Error("Missing release gate status");
  const result = raw as { sha?: unknown; statuses?: unknown };
  if (result.sha !== commit || !Array.isArray(result.statuses))
    throw new Error("Release gate status is not bound to the selected commit");
  const matches = result.statuses.filter(
    (entry: unknown) =>
      entry && typeof entry === "object" && (entry as { context?: unknown }).context === context,
  );
  if (matches.length !== 1 || (matches[0] as { state?: unknown }).state !== "success")
    throw new Error("The selected release has no successful mandatory local gate status");
}

if (import.meta.main) {
  const [filename, tag, commit] = process.argv.slice(2);
  if (!filename || !tag || !commit) throw new Error("Expected gate status file, tag and commit");
  assertReleaseGateStatus(JSON.parse(readFileSync(filename, "utf8")), tag, commit);
}
