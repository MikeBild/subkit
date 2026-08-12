import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tests = Array.from(
  new Bun.Glob("*.e2e.test.ts").scanSync({ cwd: path.join(repoRoot, "tests/e2e") }),
)
  .sort()
  .map((file) => path.join("tests/e2e", file));

if (tests.length === 0) {
  throw new Error("no E2E test files found");
}

for (const file of tests) {
  // The default verify lane is hermetic. Nightly/explicit real-provider
  // lanes keep their configured provider because nullish assignment does
  // not overwrite LLM_PROVIDER.
  const childEnv = { ...process.env };
  childEnv.LLM_PROVIDER ??= "mock";
  const child = Bun.spawn(["bun", "test", "--timeout", "120000", file], {
    cwd: repoRoot,
    env: childEnv,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${file} failed with exit code ${exitCode}`);
  }
}
