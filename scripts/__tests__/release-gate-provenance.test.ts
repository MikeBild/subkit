import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import {
  assertReleaseGateStatus,
  assertReleaseRefsUnchanged,
  releaseGateContext,
} from "../release-gate-provenance.ts";

const tag = `v${version}`;
const commit = "a".repeat(40);
const passed = { context: releaseGateContext(tag), state: "success" };

describe("release gate provenance", () => {
  test("rejects tags created or moved by a competing release while gates were running", () => {
    expect(() => assertReleaseRefsUnchanged("", "", "", commit)).not.toThrow();
    expect(() => assertReleaseRefsUnchanged(commit, commit, "", commit)).not.toThrow();
    expect(() => assertReleaseRefsUnchanged("", commit, "", commit)).toThrow();
    expect(() => assertReleaseRefsUnchanged(commit, "b".repeat(40), "", commit)).toThrow();
    expect(() => assertReleaseRefsUnchanged(commit, "", "", commit)).toThrow();
    expect(() =>
      assertReleaseRefsUnchanged("", "", `${commit} refs/tags/${tag}`, commit),
    ).toThrow();
  });
  test("accepts only a successful status for the exact tag and checkout commit", () => {
    expect(() =>
      assertReleaseGateStatus({ sha: commit, statuses: [passed] }, tag, commit),
    ).not.toThrow();
  });

  test("rejects missing, failed, ambiguous and unrelated status evidence", () => {
    for (const statuses of [
      [],
      [{ ...passed, state: "pending" }],
      [{ ...passed, state: "failure" }],
      [{ ...passed, context: "different-release" }],
      [passed, passed],
      [passed, { ...passed, state: "failure" }],
      [null, {}],
    ]) {
      expect(() => assertReleaseGateStatus({ sha: commit, statuses }, tag, commit)).toThrow();
    }
  });

  test("rejects evidence from another commit and malformed responses", () => {
    for (const raw of [null, {}, [], { sha: "b".repeat(40), statuses: [passed] }])
      expect(() => assertReleaseGateStatus(raw, tag, commit)).toThrow();
    expect(() => releaseGateContext("refs/heads/main")).toThrow();
    expect(() =>
      assertReleaseGateStatus({ sha: commit, statuses: [passed] }, tag, "HEAD"),
    ).toThrow();
  });
});
