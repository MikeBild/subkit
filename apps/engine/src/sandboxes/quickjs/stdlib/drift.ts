import { STDLIB_VERSION } from "./index.ts";

export interface StdlibDrift {
  recorded_version: string;
  current_version: string;
  recorded_major: number;
  current_major: number;
  reason: "major_bump";
}

function parseMajor(version: string): number | null {
  const m = version.match(/^(\d+)\./);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

export function detectStdlibDrift(recordedVersion: string | null | undefined): StdlibDrift | null {
  if (!recordedVersion) return null;
  const recordedMajor = parseMajor(recordedVersion);
  const currentMajor = parseMajor(STDLIB_VERSION);
  if (recordedMajor === null || currentMajor === null) return null;
  if (recordedMajor === currentMajor) return null;
  return {
    recorded_version: recordedVersion,
    current_version: STDLIB_VERSION,
    recorded_major: recordedMajor,
    current_major: currentMajor,
    reason: "major_bump",
  };
}
