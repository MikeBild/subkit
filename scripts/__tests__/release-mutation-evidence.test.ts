import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertReleaseMutationReceipt,
  buildReleaseMutationReceipt,
  releaseMutationReceiptPath,
} from "../release-mutation-evidence.ts";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const unionPath = "reports/mutation/runs/release-1/run-1/union.json";
const union = (summary: Record<string, unknown> = {}, score = 100): string =>
  JSON.stringify({
    wave_id: "release-1",
    run_id: "run-1",
    adjusted_mutation_score: score,
    score_summary: { detected: 12, undetected: 0, equivalent_excluded: 2, ...summary },
  });
const receiptFor = (unionText = union()) =>
  buildReleaseMutationReceipt({
    commit,
    tree,
    unionPath,
    unionText,
    recordedAt: "2026-11-17T00:00:00.000Z",
  });
const check = (
  receipt: unknown,
  options: { commit?: string; tree?: string; unionText?: string | null } = {},
) =>
  assertReleaseMutationReceipt({
    receiptText: receipt === null ? null : JSON.stringify(receipt),
    commit: options.commit ?? commit,
    tree: options.tree ?? tree,
    readUnion: (path) =>
      path === unionPath ? (options.unionText === undefined ? union() : options.unionText) : null,
  });

test("a receipt binds commit, tree and the exact union bytes", () => {
  const receipt = receiptFor();
  expect(receipt).toMatchObject({
    version: 1,
    commit_sha: commit,
    tree_sha: tree,
    wave_id: "release-1",
    run_id: "run-1",
    union_path: unionPath,
    union_sha256: createHash("sha256").update(union()).digest("hex"),
    detected: 12,
    undetected: 0,
    equivalent_excluded: 2,
  });
  expect(check(receipt)).toEqual(receipt);
});

test("a union with undetected mutants never becomes a receipt", () => {
  expect(() => receiptFor(union({ undetected: 1 }))).toThrow("undetected mutants");
  expect(() => receiptFor(union({}, 99.9))).toThrow("undetected mutants");
  expect(() => receiptFor(union({ detected: 0 }))).toThrow("undetected mutants");
  expect(() => receiptFor(union({ detected: "12" }))).toThrow("malformed");
  expect(() => receiptFor("{}")).toThrow("malformed");
});

test("the check names the command when evidence is missing", () => {
  expect(() => check(null)).toThrow("Run `bun run quality release` first.");
});

test("the check rejects evidence of another commit, a changed union and edited counts", () => {
  const receipt = receiptFor();
  expect(() => check(receipt, { commit: "c".repeat(40) })).toThrow("another commit");
  expect(() => check(receipt, { tree: "c".repeat(40) })).toThrow("another commit");
  expect(() => check(receipt, { unionText: null })).toThrow("missing or changed");
  expect(() => check(receipt, { unionText: union({ detected: 13 }) })).toThrow(
    "missing or changed",
  );
  const failing = union({ undetected: 1 });
  expect(() =>
    check(
      { ...receipt, union_sha256: createHash("sha256").update(failing).digest("hex") },
      { unionText: failing },
    ),
  ).toThrow("undetected mutants");
  expect(() => check({ ...receipt, detected: 11 })).toThrow("differs from its union");
  expect(() => check({ ...receipt, version: 2 })).toThrow("malformed");
  expect(() => check({ ...receipt, union_path: "../union.json" })).toThrow("malformed");
  expect(() => check({ ...receipt, recorded_at: "soon" })).toThrow("malformed");
});

test("the receipt path is derived from a full commit id only", () => {
  expect(releaseMutationReceiptPath("/repo", commit)).toBe(
    `/repo/reports/mutation/release/${commit}.json`,
  );
  expect(() => releaseMutationReceiptPath("/repo", "HEAD")).toThrow("malformed");
});
