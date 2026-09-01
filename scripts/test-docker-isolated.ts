import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tests = Array.from(
  new Bun.Glob("*.docker.test.ts").scanSync({ cwd: path.join(repoRoot, "tests/docker") }),
)
  .sort()
  .map((file) => path.join("tests/docker", file));

if (tests.length === 0) {
  throw new Error("no Docker E2E test files found");
}

// Every Docker file controls the same Compose project. Running their
// beforeAll hooks in one Bun process lets compose up / force-recreate race
// across files and can replace PostgreSQL underneath an active test. A fresh
// process per file preserves the shared external state while serialising all
// Compose mutations.
for (const [index, file] of tests.entries()) {
  process.stdout.write(`[docker-isolated] ${index + 1}/${tests.length} ${file}\n`);
  const child = Bun.spawn(["bun", "test", "--timeout", "600000", file], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${file} failed with exit code ${exitCode}`);
  }
}
