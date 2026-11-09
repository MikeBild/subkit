import { expect, test } from "bun:test";
import { parseQualityBundleIndex } from "../verify-shard-quality-bundle.ts";

const commit = "a".repeat(40);
const index = {
  version: 1,
  commit_sha: commit,
  acceptance_path: "reports/acceptance.json",
  mutation_union_path: "reports/mutation/union.json",
  coverage_union_path: "reports/coverage/union.json",
  files: [
    "reports/acceptance.json",
    "reports/mutation/union.json",
    "reports/coverage/union.json",
  ].map((path) => ({ path, sha256: "b".repeat(64) })),
};

test("binds complete bundle references to the exact commit", () => {
  expect(parseQualityBundleIndex(index, commit)).toEqual(index);
  expect(() => parseQualityBundleIndex(index, "c".repeat(40))).toThrow("release commit");
  expect(() => parseQualityBundleIndex(index, "main")).toThrow("Invalid expected");
});

test("rejects missing evidence, duplicate files and path escapes", () => {
  for (const value of [
    null,
    {},
    { ...index, version: 2 },
    { ...index, files: [] },
    { ...index, files: [...index.files, index.files[0]] },
    ...["../secret", "/etc/passwd", "reports/../secret", "reports\\secret"].map((path) => ({
      ...index,
      files: [...index.files, { path, sha256: "b".repeat(64) }],
    })),
    { ...index, files: [...index.files, { path: "reports/extra", sha256: "bad" }] },
  ])
    expect(() => parseQualityBundleIndex(value, commit)).toThrow();
});
