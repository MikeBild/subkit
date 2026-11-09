import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { reviewedRuntimeWitnesses } from "../audit/runtime-witnesses.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const consumer = "src/worker.ts";
const testPath = "src/worker.test.ts";
const source: Record<string, string> = {
  [consumer]: "postMessage({ ready: true });",
  [testPath]: 'new Worker(new URL("./worker.ts", import.meta.url));',
};
const witnessDigest = hash(`${consumer}\0${source[consumer]}\0${testPath}\0${source[testPath]}\0`);
const receiptPath =
  ".artifacts/goal-verification/runs/runtime-witness-fixture/runtime-witness.json";
const runDirectory = receiptPath.slice(0, -"/runtime-witness.json".length);
const receipt = JSON.stringify({
  version: 1,
  status: "passed",
  exit_code: 0,
  source_digest: witnessDigest,
  command: "bun",
  args: ["test", testPath],
});
const entry = {
  consumer,
  test: testPath,
  consumer_sha256: hash(source[consumer]!),
  test_sha256: hash(source[testPath]!),
  kind: "source-worker",
  rationale: "Worker is launched from source in an isolated process.",
  independent_review: "Review fixture: exact Worker URL targets the consumer.",
  execution_receipt_path: receiptPath,
  execution_receipt_sha256: hash(receipt),
};
const check = (runtime_witnesses: unknown) =>
  reviewedRuntimeWitnesses({
    ledger: { runtime_witnesses },
    files: Object.keys(source),
    readText: (path) => source[path] ?? null,
    readArtifact: (path) => {
      if (path === receiptPath) return receipt;
      if (path === `${runDirectory}/manifest.json`)
        return JSON.stringify({
          format: "subkit-verification-run",
          version: 1,
          status: "passed",
          resultPath: "result.json",
          sourceDigest: witnessDigest,
        });
      if (path === `${runDirectory}/result.json`)
        return JSON.stringify({
          status: "passed",
          exitCode: 0,
          timedOut: false,
          command: "bun",
          args: ["test", testPath],
        });
      return null;
    },
  });

test("binds a reviewed source launch to exact source and test bytes", () => {
  const result = check([entry]);
  expect(result.errors).toEqual([]);
  expect(result.witnesses.get(consumer)).toEqual(new Set([testPath]));
});

test("rejects stale source/test, missing review, binary-only launch, bad receipts and unknown paths", () => {
  for (const patch of [
    { consumer_sha256: hash("changed") },
    { test_sha256: hash("changed") },
    { independent_review: "" },
    { kind: "compiled-binary" },
    { execution_receipt_sha256: hash("changed") },
    { execution_receipt_path: "receipt.json" },
    { consumer: "../outside.ts" },
    { test: "src/not-a-test.ts" },
  ]) {
    const result = check([{ ...entry, ...patch }]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.witnesses.size).toBe(0);
  }
});

test("rejects duplicate and malformed runtime records", () => {
  expect(check([entry, entry]).errors).toContain(
    `duplicate runtime witness: ${consumer} -> ${testPath}`,
  );
  expect(check({}).errors).toEqual(["runtime witnesses must be an array"]);
  expect(check([null]).errors).toEqual(["malformed runtime witness"]);
});
