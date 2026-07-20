import { statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const targets = process.argv.slice(2);
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
  throw new Error("usage: bun run scripts/test-files-isolated.ts <file-or-directory> [...]");
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

const orderedTests = [...tests].sort();
if (orderedTests.length === 0) throw new Error("no test files found");

for (const [index, file] of orderedTests.entries()) {
  process.stdout.write(`[isolated-test] ${index + 1}/${orderedTests.length} ${file}\n`);
  const child = Bun.spawn(["bun", "test", "--timeout", "120000", file], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: "test" },
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
