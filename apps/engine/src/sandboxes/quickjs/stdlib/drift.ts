// Stdlib-version drift detection.
//
// When a workflow is persisted with JS-based steps or hooks, the
// STDLIB_VERSION in force at commit time is expected to be recorded
// on the workflow version's DAG metadata (e.g.
// `dag.runtime.stdlib_version`). At run time — or when
// `self-healing/` scans a failing execution — this helper compares
// the recorded version against the engine's current STDLIB_VERSION
// and reports a drift if the semver major has moved.
//
// Semver contract (see ./README.md):
//   - Patch bumps     → no drift, fully compatible.
//   - Minor bumps     → no drift, additive surface only.
//   - Major bumps     → drift, behaviour may have changed.
//
// The caller (self-healing/service.ts) is responsible for turning
// a non-null result into a Patch-Candidate. This module stays pure
// and has no DB or IO dependencies.

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

/**
 * Returns null if the workflow's recorded stdlib version is null or
 * compatible with the current engine version. Returns a
 * `StdlibDrift` when a major-version gap is detected.
 *
 * A recorded version of `null` or an empty string means the workflow
 * was persisted before stdlib-version tracking was wired — treat as
 * compatible; the drift signal only fires for *detected* mismatches.
 */
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
