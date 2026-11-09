import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { isCanonicalRepoPath } from "./audit/mutation-wave.ts";
import { QUALITY_RUNTIME_WITNESSES } from "./audit/quality-runtime-witness-policy.ts";

const repo = resolve(import.meta.dir, "../../..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? undefined : process.argv[outIndex + 1];
if (!isCanonicalRepoPath(out)) throw new Error("--out requires a repository-relative ledger path");
const root = verificationRunsRoot(repo);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const pairs = QUALITY_RUNTIME_WITNESSES;
const entries = [];
for (const pair of pairs) {
  const source = read(pair.consumer);
  const testSource = read(pair.test);
  const digest = hash(`${pair.consumer}\0${source}\0${pair.test}\0${testSource}\0`);
  const owner = `runtime-witness:${randomUUID()}`;
  const exitCode = await runWithVerificationLog({
    root,
    owner,
    command: "bun",
    args: ["test", pair.test],
    sourceDigest: digest,
    retention: "pinned",
    cwd: repo,
    env: { ...process.env, NODE_ENV: "test", LLM_PROVIDER: "mock", SKIP_DOCKER: "1" },
    timeoutMs: 60_000,
  });
  if (exitCode !== 0) throw new Error(`Runtime witness failed: ${pair.consumer}`);
  if (source !== read(pair.consumer) || testSource !== read(pair.test))
    throw new Error("Runtime witness inputs changed during execution");
  const runId = readdirSync(root).find((id) => {
    try {
      return JSON.parse(readFileSync(join(root, id, "manifest.json"), "utf8")).owner === owner;
    } catch {
      return false;
    }
  });
  if (!runId) throw new Error("Owned runtime witness receipt not found");
  const receiptPath = join(root, runId, "runtime-witness.json");
  const receiptText = `${JSON.stringify({ version: 1, status: "passed", exit_code: 0, source_digest: digest, command: "bun", args: ["test", pair.test] }, null, 2)}\n`;
  writeFileSync(receiptPath, receiptText, { flag: "wx" });
  entries.push({
    ...pair,
    consumer_sha256: hash(source),
    test_sha256: hash(testSource),
    execution_receipt_path: relative(repo, receiptPath),
    execution_receipt_sha256: hash(receiptText),
  });
}
mkdirSync(dirname(join(repo, out)), { recursive: true });
writeFileSync(
  join(repo, out),
  `${JSON.stringify({ version: 1, runtime_witnesses: entries }, null, 2)}\n`,
);
console.log(`Recorded ${entries.length} source runtime witnesses with pinned execution evidence.`);
