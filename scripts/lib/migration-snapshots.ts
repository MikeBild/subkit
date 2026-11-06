import { readdirSync } from "node:fs";

const SNAPSHOT = /^(\d{4})_snapshot\.json$/;

export function staleSnapshots(fileNames: readonly string[]): string[] {
  const snapshots = fileNames
    .map((name) => ({ name, match: SNAPSHOT.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  return snapshots.slice(0, -1).map((entry) => entry.name);
}

export function staleSnapshotsIn(metaDir: string): string[] {
  return staleSnapshots(readdirSync(metaDir));
}
