import { createHash } from "node:crypto";

export function reviewedRuntimeWitnesses(input: {
  ledger: unknown;
  files: readonly string[];
  readText: (path: string) => string | null;
  readArtifact?: (path: string) => string | null;
}): { witnesses: Map<string, Set<string>>; errors: string[] } {
  const witnesses = new Map<string, Set<string>>();
  const errors: string[] = [];
  const ledger = input.ledger as { runtime_witnesses?: unknown } | null;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger))
    return { witnesses, errors: ["runtime witness ledger must be an object"] };
  if (ledger.runtime_witnesses === undefined) return { witnesses, errors };
  if (!Array.isArray(ledger.runtime_witnesses))
    return { witnesses, errors: ["runtime witnesses must be an array"] };
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const witnessDigest = (consumer: string, source: string, test: string, testSource: string) =>
    hash(`${consumer}\0${source}\0${test}\0${testSource}\0`);
  const known = new Set(input.files);
  for (const raw of ledger.runtime_witnesses) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("malformed runtime witness");
      continue;
    }
    const row = raw as Record<string, unknown>;
    const {
      consumer,
      test,
      consumer_sha256,
      test_sha256,
      kind,
      rationale,
      independent_review,
      execution_receipt_path,
      execution_receipt_sha256,
    } = row;
    if (
      typeof consumer !== "string" ||
      typeof test !== "string" ||
      !known.has(consumer) ||
      !known.has(test) ||
      !/\.(test|spec)\.tsx?$/.test(test) ||
      !["source-process", "source-worker", "source-browser"].includes(String(kind)) ||
      typeof rationale !== "string" ||
      !rationale.trim() ||
      typeof independent_review !== "string" ||
      !independent_review.trim()
    ) {
      errors.push("runtime witness lacks known source/test or independent review");
      continue;
    }
    const source = input.readText(consumer);
    const testSource = input.readText(test);
    if (
      source === null ||
      testSource === null ||
      hash(source) !== consumer_sha256 ||
      hash(testSource) !== test_sha256
    ) {
      errors.push(`stale runtime witness: ${consumer} -> ${test}`);
      continue;
    }
    if (
      typeof execution_receipt_path !== "string" ||
      !execution_receipt_path.startsWith(".artifacts/goal-verification/runs/") ||
      !execution_receipt_path.endsWith("/runtime-witness.json") ||
      execution_receipt_path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof execution_receipt_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(execution_receipt_sha256)
    ) {
      errors.push(`runtime witness lacks a safe execution receipt: ${consumer} -> ${test}`);
      continue;
    }
    const receiptText = input.readArtifact?.(execution_receipt_path) ?? null;
    if (!receiptText || hash(receiptText) !== execution_receipt_sha256) {
      errors.push(`runtime witness receipt is stale or unavailable: ${consumer} -> ${test}`);
      continue;
    }
    const runDirectory = execution_receipt_path.slice(0, -"/runtime-witness.json".length);
    const manifestText = input.readArtifact?.(`${runDirectory}/manifest.json`) ?? null;
    const resultText = input.readArtifact?.(`${runDirectory}/result.json`) ?? null;
    let receipt: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(receiptText);
      receipt =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {}
    let manifest: Record<string, unknown> | null = null;
    let result: Record<string, unknown> | null = null;
    try {
      const parsed = manifestText === null ? null : JSON.parse(manifestText);
      manifest =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const resultParsed = resultText === null ? null : JSON.parse(resultText);
      result =
        resultParsed && typeof resultParsed === "object" && !Array.isArray(resultParsed)
          ? (resultParsed as Record<string, unknown>)
          : null;
    } catch {}
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.status !== "passed" ||
      receipt.exit_code !== 0 ||
      receipt.source_digest !== witnessDigest(consumer, source, test, testSource) ||
      receipt.command !== "bun" ||
      !Array.isArray(receipt.args) ||
      receipt.args.length !== 2 ||
      receipt.args[0] !== "test" ||
      receipt.args[1] !== test
    ) {
      errors.push(
        `runtime witness receipt does not prove the source test launch: ${consumer} -> ${test}`,
      );
      continue;
    }
    if (
      !manifest ||
      manifest.format !== "subkit-verification-run" ||
      manifest.version !== 1 ||
      manifest.status !== "passed" ||
      manifest.resultPath !== "result.json" ||
      manifest.sourceDigest !== receipt.source_digest ||
      !result ||
      result.status !== "passed" ||
      result.exitCode !== 0 ||
      result.timedOut !== false ||
      result.command !== receipt.command ||
      JSON.stringify(result.args) !== JSON.stringify(receipt.args)
    ) {
      errors.push(
        `runtime witness is not inside a successful owned verification run: ${consumer} -> ${test}`,
      );
      continue;
    }
    const tests = witnesses.get(consumer) ?? new Set<string>();
    if (tests.has(test)) errors.push(`duplicate runtime witness: ${consumer} -> ${test}`);
    tests.add(test);
    witnesses.set(consumer, tests);
  }
  return { witnesses, errors };
}
