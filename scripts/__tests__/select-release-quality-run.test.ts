import { expect, test } from "bun:test";
import {
  type QualityWorkflowRun,
  selectReleaseQualityArtifacts,
  selectReleaseQualityRun,
  verifySelectedReleaseQualityRun,
} from "../select-release-quality-run.ts";

const commit = "a".repeat(40);
const repository = "MikeBild/subkit";
const valid = (overrides: Partial<QualityWorkflowRun> = {}): QualityWorkflowRun => ({
  id: 42,
  head_sha: commit,
  head_repository: { full_name: repository },
  path: ".github/workflows/quality.yml",
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  run_attempt: 3,
  ...overrides,
});
const runs = (workflow_runs: QualityWorkflowRun[], total_count = workflow_runs.length) => ({
  workflow_runs,
  total_count,
});

test("selects exactly one successful primary-repository quality push for the release commit", () => {
  expect(selectReleaseQualityRun({ commit, repository, runs: runs([valid()]) })).toEqual(valid());
});

test("fails closed for wrong quality producer identity or completion state", () => {
  for (const run of [
    valid({ head_sha: "b".repeat(40) }),
    valid({ head_repository: { full_name: "fork/subkit" } }),
    valid({ path: ".github/workflows/other.yml" }),
    valid({ event: "workflow_dispatch" }),
    valid({ head_branch: "feature" }),
    valid({ status: "in_progress", conclusion: null }),
    valid({ conclusion: "cancelled" }),
    valid({ run_attempt: 0 }),
  ])
    expect(() => selectReleaseQualityRun({ commit, repository, runs: runs([run]) })).toThrow(
      "expected exactly one",
    );
});

test("fails closed for missing or ambiguous producer candidates and stale rerun details", () => {
  expect(() => selectReleaseQualityRun({ commit, repository, runs: runs([]) })).toThrow(
    "expected exactly one",
  );
  expect(() =>
    selectReleaseQualityRun({
      commit,
      repository,
      runs: runs([valid(), valid({ id: 43 })]),
    }),
  ).toThrow("expected exactly one");
  expect(() =>
    verifySelectedReleaseQualityRun({
      commit,
      repository,
      runId: "42",
      runAttempt: "3",
      run: valid({ run_attempt: 4 }),
    }),
  ).toThrow("changed after selection");
  expect(() => selectReleaseQualityRun({ commit, repository, runs: runs([valid()], 2) })).toThrow(
    "incomplete or malformed",
  );
});

test("requires exactly one unexpired coverage artifact from the selected producer run", () => {
  const artifact = (name: string, overrides: Record<string, unknown> = {}) => ({
    id: name === "coverage-floor-evidence" ? 72 : 71,
    name,
    expired: false,
    digest: `sha256:${"c".repeat(64)}`,
    workflow_run: { id: 42, head_sha: commit },
    ...overrides,
  });
  expect(
    selectReleaseQualityArtifacts({
      commit,
      runId: "42",
      artifacts: {
        artifacts: [artifact("quality-failure-coverage"), artifact("coverage-floor-evidence")],
        total_count: 2,
      },
    }),
  ).toEqual({
    coverageFloorEvidenceId: 72,
    coverageFloorEvidenceDigest: `sha256:${"c".repeat(64)}`,
  });
  for (const artifacts of [
    [artifact("quality-failure-coverage")],
    [artifact("coverage-floor-evidence"), artifact("coverage-floor-evidence", { id: 73 })],
    [artifact("coverage-floor-evidence", { expired: true })],
    [artifact("coverage-floor-evidence", { workflow_run: { id: 43, head_sha: commit } })],
    [artifact("coverage-floor-evidence", { workflow_run: { id: 42, head_sha: "b".repeat(40) } })],
    [artifact("coverage-floor-evidence", { workflow_run: null })],
    [artifact("coverage-floor-evidence", { digest: "invalid" })],
  ])
    expect(() =>
      selectReleaseQualityArtifacts({
        commit,
        runId: "42",
        artifacts: {
          artifacts,
          total_count: artifacts.length,
        },
      }),
    ).toThrow("expected exactly one");

  expect(() =>
    selectReleaseQualityArtifacts({
      commit,
      runId: "42",
      artifacts: {
        artifacts: [artifact("coverage-floor-evidence")],
        total_count: 2,
      },
    }),
  ).toThrow("incomplete or malformed");
});
