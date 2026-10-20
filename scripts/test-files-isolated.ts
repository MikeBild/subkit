import { statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
let listOnly = false;
let shardIndex = 0;
let shardCount = 1;
let startAfter: string | undefined;
const workersRaw = process.env.SUBKIT_TEST_WORKERS ?? "1";
const workers = Number(workersRaw);
if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
  throw new Error("SUBKIT_TEST_WORKERS must be an integer between 1 and 4");
}
const workerChild = process.env.SUBKIT_TEST_WORKER_CHILD === "1";
const targets: string[] = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--list") {
    listOnly = true;
    continue;
  }
  if (arg === "--shard") {
    const value = args[index + 1];
    const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
    if (!match) throw new Error("--shard must use the form <index>/<count>, for example 1/8");
    const displayIndex = Number(match[1]);
    shardCount = Number(match[2]);
    if (shardCount < 1 || displayIndex < 1 || displayIndex > shardCount) {
      throw new Error("--shard index must be between 1 and count");
    }
    shardIndex = displayIndex - 1;
    index += 1;
    continue;
  }
  if (arg === "--start-after") {
    startAfter = args[index + 1];
    if (!startAfter) throw new Error("--start-after requires a test file path");
    index += 1;
    continue;
  }
  if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
  targets.push(arg);
}
const testPatterns = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
];

if (targets.length === 0) {
  throw new Error(
    "usage: bun run scripts/test-files-isolated.ts [--list] [--shard <index>/<count>] [--start-after <file>] <file-or-directory> [...]",
  );
}
const hasExplicitSelection = listOnly || startAfter !== undefined || shardCount !== 1;
if (workers > 1 && !workerChild && !hasExplicitSelection) {
  const exits = await Promise.all(
    Array.from({ length: workers }, async (_, index) => {
      const child = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/test-files-isolated.ts",
          "--shard",
          `${index + 1}/${workers}`,
          ...targets,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, SUBKIT_TEST_WORKERS: "1", SUBKIT_TEST_WORKER_CHILD: "1" },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      return child.exited;
    }),
  );
  if (exits.some((exitCode) => exitCode !== 0)) process.exit(1);
  process.exit(0);
}

function repoRelative(target: string): string {
  const absolute = path.resolve(repoRoot, target);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`test target is outside the repository: ${target}`);
  }
  return relative;
}

const tests = new Set<string>();
for (const target of targets) {
  const relative = repoRelative(target);
  const absolute = path.join(repoRoot, relative);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    tests.add(relative);
    continue;
  }
  if (!stat.isDirectory()) throw new Error(`unsupported test target: ${target}`);
  for (const pattern of testPatterns) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: absolute })) {
      tests.add(path.join(relative, file));
    }
  }
}

const allTests = [...tests].sort();
if (allTests.length === 0) throw new Error("no test files found");

const shardedTests = allTests.filter((_, index) => index % shardCount === shardIndex);
const startIndex = startAfter === undefined ? -1 : shardedTests.indexOf(repoRelative(startAfter));
if (startAfter !== undefined && startIndex === -1) {
  throw new Error(`--start-after file is not in the selected test set: ${startAfter}`);
}
const orderedTests = shardedTests.slice(startIndex + 1);
if (orderedTests.length === 0) throw new Error("selected shard contains no test files");

if (listOnly) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${orderedTests.join("\n")}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  process.exit(0);
}

for (const [index, file] of orderedTests.entries()) {
  const shardLabel = shardCount === 1 ? "" : ` shard=${shardIndex + 1}/${shardCount}`;
  process.stdout.write(
    `[isolated-test] ${index + 1}/${orderedTests.length}${shardLabel} ${file}\n`,
  );
  const childEnv = { ...process.env, NODE_ENV: "test" };
  childEnv.LLM_PROVIDER ??= "mock";
  const child = Bun.spawn(["bun", "test", "--timeout", "120000", file], {
    cwd: repoRoot,
    env: childEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exited = child.exited;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), 150_000);
    }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (outcome.kind === "timeout") {
    child.kill("SIGTERM");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        stopTimer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (stopTimer) clearTimeout(stopTimer);
    if (!stopped) child.kill("SIGKILL");
    await exited;
    throw new Error(`${file} exceeded the 150000ms process deadline`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`${file} failed with exit code ${outcome.exitCode}`);
  }
}
