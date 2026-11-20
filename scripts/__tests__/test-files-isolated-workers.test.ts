import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..");
const fixture = path.join(root, "scripts", "__tests__", "test-files-isolated-worker-fixtures");
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

async function run(workers: string, ...args: string[]) {
  return Bun.spawn([process.execPath, "scripts/test-files-isolated.ts", ...args], {
    cwd: root,
    env: { ...process.env, SUBKIT_TEST_WORKERS: workers, SUBKIT_TEST_WORKER_CHILD: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function fixtures() {
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    path.join(fixture, "one.test.ts"),
    'import { test } from "bun:test"; test("one", () => {});',
  );
  writeFileSync(
    path.join(fixture, "two.test.ts"),
    'import { test } from "bun:test"; test("two", () => {});',
  );
}

describe("test-files-isolated workers", () => {
  test("runs every file once across worker shards", async () => {
    fixtures();
    const child = await run("2", "scripts/__tests__/test-files-isolated-worker-fixtures");
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(output).toContain("shard=1/2");
    expect(output).toContain("shard=2/2");
  });

  test("propagates a shard failure", async () => {
    fixtures();
    writeFileSync(
      path.join(fixture, "fail.test.ts"),
      'import { test, expect } from "bun:test"; test("fail", () => expect(true).toBe(false));',
    );
    const child = await run("2", "scripts/__tests__/test-files-isolated-worker-fixtures");
    expect(await child.exited).toBe(1);
  });

  test("keeps the default serial behavior", async () => {
    fixtures();
    const child = await run("1", "scripts/__tests__/test-files-isolated-worker-fixtures");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain("shard=");
  });

  test("uses serial selection when explicit controls are present", async () => {
    fixtures();
    const child = await run("2", "--list", "scripts/__tests__/test-files-isolated-worker-fixtures");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).not.toContain("shard=");
  });

  test("leaves out installed packages and build output", async () => {
    fixtures();
    for (const directory of ["node_modules/pkg", "dist", "release", "nested/node_modules/pkg"]) {
      mkdirSync(path.join(fixture, directory), { recursive: true });
      writeFileSync(path.join(fixture, directory, "foreign.spec.ts"), "");
    }
    const child = await run("1", "--list", "scripts/__tests__/test-files-isolated-worker-fixtures");
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim().split("\n")).toEqual([
      "scripts/__tests__/test-files-isolated-worker-fixtures/one.test.ts",
      "scripts/__tests__/test-files-isolated-worker-fixtures/two.test.ts",
    ]);
  });
});
