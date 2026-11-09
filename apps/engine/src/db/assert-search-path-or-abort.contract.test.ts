import { expect, test } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function run(assertion: "passes" | "fails") {
  const script = `
import { mock } from "bun:test";
const root = ${JSON.stringify(ROOT)};
mock.module(root + "/db/client.ts", () => ({
  getPool: () => ({ marker: "pool" }),
  assertSearchPath: async () => {
    if (${JSON.stringify(assertion)} === "fails") throw new Error("schema does not exist");
  },
}));
mock.module(root + "/logging/logger.ts", () => ({
  logger: { fatal: (entry) => console.error("FATAL_ACTION=" + entry.action) },
  errorFields: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
}));
const { assertSearchPathOrAbort } = await import(root + "/db/assert-search-path-or-abort.ts");
await assertSearchPathOrAbort();
`;
  return Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
}

test("lets boot continue only when the database resolves the subkit search path", () => {
  const child = run("passes");
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toBe("");
});

test("terminates boot with a fatal search-path event when the schema is invalid", () => {
  const child = run("fails");
  const stderr = new TextDecoder().decode(child.stderr);
  expect(child.exitCode).toBe(1);
  expect(stderr).toContain("FATAL_ACTION=search_path.failed_aborting_boot");
  expect(stderr).not.toContain("process.exit(0)");
});
