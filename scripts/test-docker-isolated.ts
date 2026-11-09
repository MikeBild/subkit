import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildFreshImage,
  cleanupDockerTestRun,
  createIsolatedDockerTestRun,
  dockerTestChildEnv,
  runEnv,
} from "../tests/docker/_run.ts";
import { type OwnedChild, startOwnedChild } from "./lib/owned-process-watchdog.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const availableTests = Array.from(
  new Bun.Glob("*.docker.test.ts").scanSync({
    cwd: path.join(repoRoot, "tests/docker"),
  }),
)
  .sort()
  .map((file) => path.join("tests/docker", file));

const args = process.argv.slice(2);
const repeatFlag = args.find((arg) => arg.startsWith("--repeat="));
const repeat = Number(repeatFlag?.slice("--repeat=".length) ?? "1");
const mode = args.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) ?? "cold";
const seedState =
  args.find((arg) => arg.startsWith("--seed-state="))?.slice("--seed-state=".length) ?? "natural";
const selectors = args.filter((arg) => !arg.startsWith("--"));
const resultIndex = args
  .find((arg) => arg.startsWith("--result-index="))
  ?.slice("--result-index=".length);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
if (mode !== "cold" && mode !== "warm") throw new Error("--mode must be cold or warm");
if (seedState !== "natural" && seedState !== "unchanged" && seedState !== "changed")
  throw new Error("--seed-state must be natural, unchanged, or changed");
const tests =
  selectors.length === 0
    ? availableTests
    : availableTests.filter((file) => selectors.some((selector) => file.includes(selector)));

if (tests.length === 0) {
  throw new Error("no Docker E2E test files found");
}

const buildReceipts: Array<{
  attempt: number;
  project: string;
  image_id: string;
  source: { revision: string; dirty: boolean; digest: string };
  context_digest: string;
  platform: string;
  receipt_path?: string;
  receipt_sha256: string;
}> = [];

function withBuiltImage(
  run: ReturnType<typeof createIsolatedDockerTestRun>,
  built: ReturnType<typeof buildFreshImage>,
) {
  return {
    ...run,
    image: built.image,
    ...(built.receiptPath ? { receiptPath: built.receiptPath } : {}),
    ...(built.hostCliPath ? { hostCliPath: built.hostCliPath } : {}),
  };
}

const activeRuns = new Map<string, ReturnType<typeof createIsolatedDockerTestRun>>();
let activeChild: OwnedChild | undefined;
let interrupted = false;

function cleanupActiveRun(run: ReturnType<typeof createIsolatedDockerTestRun>) {
  if (!activeRuns.delete(run.project)) return undefined;
  return cleanupDockerTestRun(run);
}

function interrupt(signal: NodeJS.Signals) {
  if (interrupted) return;
  interrupted = true;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  if (activeChild) {
    activeChild.stop();
    void activeChild.completed.finally(() => {
      for (const run of activeRuns.values()) cleanupActiveRun(run);
    });
  } else {
    for (const run of activeRuns.values()) cleanupActiveRun(run);
  }
}

process.on("SIGINT", () => interrupt("SIGINT"));
process.on("SIGTERM", () => interrupt("SIGTERM"));

for (let attempt = 1; attempt <= repeat; attempt += 1) {
  if (interrupted) throw new Error("Docker isolated runner interrupted");
  const built = buildFreshImage(createIsolatedDockerTestRun(`suite-${attempt}`));
  if (!built.receiptPath) throw new Error("fresh Docker build did not return a receipt path");
  const receiptText = readFileSync(built.receiptPath, "utf8");
  const receipt = JSON.parse(receiptText) as {
    project?: unknown;
    image_id?: unknown;
    source?: { revision?: unknown; dirty?: unknown; digest?: unknown };
    context?: { digest?: unknown };
    platform?: unknown;
  };
  if (
    typeof receipt.project !== "string" ||
    typeof receipt.image_id !== "string" ||
    typeof receipt.source?.revision !== "string" ||
    typeof receipt.source?.dirty !== "boolean" ||
    typeof receipt.source?.digest !== "string" ||
    typeof receipt.context?.digest !== "string" ||
    typeof receipt.platform !== "string"
  )
    throw new Error("fresh Docker build receipt is malformed");
  const nativeReceiptPath = resultIndex
    ? path.join(`${resultIndex}.receipts`, `${attempt}.json`)
    : undefined;
  if (nativeReceiptPath) {
    mkdirSync(path.dirname(nativeReceiptPath), { recursive: true });
    writeFileSync(nativeReceiptPath, receiptText, { flag: "wx" });
  }
  buildReceipts.push({
    attempt,
    project: receipt.project,
    image_id: receipt.image_id,
    source: {
      revision: receipt.source.revision,
      dirty: receipt.source.dirty,
      digest: receipt.source.digest,
    },
    context_digest: receipt.context.digest,
    platform: receipt.platform,
    ...(nativeReceiptPath
      ? { receipt_path: path.relative(path.dirname(resultIndex!), nativeReceiptPath) }
      : {}),
    receipt_sha256: createHash("sha256").update(receiptText).digest("hex"),
  });
  const warmScenario =
    mode === "warm"
      ? withBuiltImage(createIsolatedDockerTestRun(`warm-${attempt}`), built)
      : undefined;
  let attemptFailed = false;
  try {
    for (const [index, file] of tests.entries()) {
      if (interrupted) throw new Error("Docker isolated runner interrupted");
      const scenario =
        warmScenario ??
        withBuiltImage(createIsolatedDockerTestRun(`case-${attempt}-${index + 1}`), built);
      activeRuns.set(scenario.project, scenario);
      process.stdout.write(
        `[docker-isolated] ${attempt}/${repeat} ${index + 1}/${tests.length} ${file} project=${scenario.project}\n`,
      );
      let scenarioFailed = false;
      let profileCaptureFailed = false;
      let cleanupFailed = false;
      try {
        activeChild = startOwnedChild(
          "bun",
          ["test", "--timeout", "600000", file],
          {
            cwd: repoRoot,
            env: dockerTestChildEnv(scenario, mode, seedState),
            stdio: "inherit",
            detached: false,
          },
          20 * 60_000,
        );
        const watched = await activeChild.completed;
        activeChild = undefined;
        if (watched.timedOut) throw new Error(`${file} timed out after 20 minutes`);
        if (watched.error) throw new Error(`${file} failed to start: ${watched.error}`);
        const exitCode = watched.exitCode;
        if (exitCode !== 0) {
          scenarioFailed = true;
          throw new Error(`${file} failed with exit code ${exitCode}`);
        }
      } finally {
        if (mode === "cold") {
          const cleanup = cleanupActiveRun(scenario);
          profileCaptureFailed = cleanup?.profileCaptureFailed ?? true;
          cleanupFailed = cleanup?.cleanupFailed ?? true;
        }
      }
      if (!scenarioFailed && cleanupFailed)
        throw new Error(`${file} completed but Docker cleanup failed`);
      if (!scenarioFailed && profileCaptureFailed)
        throw new Error(`${file} completed but its requested CPU profile was not captured`);
    }
    if (warmScenario) {
      if (interrupted) throw new Error("Docker isolated runner interrupted");
      activeRuns.set(warmScenario.project, warmScenario);
      activeChild = startOwnedChild(
        "bun",
        ["tests/docker/_finalize-seeds.ts"],
        {
          cwd: repoRoot,
          env: { ...process.env, ...runEnv(warmScenario), NODE_ENV: "test" },
          stdio: "inherit",
          detached: false,
        },
        20 * 60_000,
      );
      const watched = await activeChild.completed;
      activeChild = undefined;
      if (watched.timedOut || watched.error || watched.exitCode !== 0)
        throw new Error("post-CRUD seed verification failed");
    }
  } catch (err) {
    attemptFailed = true;
    throw err;
  } finally {
    const warmCleanup = warmScenario ? cleanupActiveRun(warmScenario) : undefined;
    if (!attemptFailed && (warmCleanup?.profileCaptureFailed || warmCleanup?.cleanupFailed))
      process.exitCode = 1;
  }
}

if (resultIndex) {
  mkdirSync(path.dirname(resultIndex), { recursive: true });
  writeFileSync(
    resultIndex,
    `${JSON.stringify({ version: 1, mode, repeat, tests, builds: buildReceipts }, null, 2)}\n`,
    { flag: "wx" },
  );
}
