import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWithVerificationLog } from "../run-with-verification-log.ts";

const roots: string[] = [];
function root() {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "subkit-runner-integration-")));
  roots.push(value);
  return join(value, "runs");
}
function onlyManifest(runs: string) {
  const directory = join(runs, readdirSync(runs)[0]!);
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runner child did not become ready");
}

test("runner writes a durable log and finalizes successful child evidence", async () => {
  const runs = root();
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      timeoutMs: 2_000,
    }),
  ).toBe(0);
  const manifest = onlyManifest(runs);
  expect(manifest.status).toBe("passed");
  expect(manifest).toMatchObject({ logPath: "runner.log", resultPath: "result.json" });
});

test("runner creates the declared log even when a successful child is silent", async () => {
  const runs = root();
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 2_000,
    }),
  ).toBe(0);
  const directory = join(runs, readdirSync(runs)[0]!);
  expect(readFileSync(join(directory, "runner.log"), "utf8")).toBe("");
});

test("runner isolates supplied cwd and environment and records its source digest", async () => {
  const runs = root();
  const cwd = dirname(runs);
  const sourceDigest = "a".repeat(64);
  const original = process.env.SUBKIT_RUNNER_FIXTURE;
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({cwd:process.cwd(),marker:process.env.SUBKIT_RUNNER_FIXTURE}))",
      ],
      timeoutMs: 2_000,
      cwd,
      env: { ...process.env, SUBKIT_RUNNER_FIXTURE: "isolated" },
      sourceDigest,
    }),
  ).toBe(0);
  expect(process.env.SUBKIT_RUNNER_FIXTURE).toBe(original);
  const directory = join(runs, readdirSync(runs)[0]!);
  expect(JSON.parse(readFileSync(join(directory, "runner.log"), "utf8"))).toEqual({
    cwd,
    marker: "isolated",
  });
  expect(onlyManifest(runs).sourceDigest).toBe(sourceDigest);
});

test("a result-write failure cannot finalize successful evidence", async () => {
  const runs = root();
  await expect(
    runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: [
        "-e",
        'const fs = require("node:fs"); const path = require("node:path"); const root = process.argv.at(-1); fs.mkdirSync(path.join(root, fs.readdirSync(root)[0], "result.json"));',
        runs,
      ],
      timeoutMs: 2_000,
    }),
  ).rejects.toThrow();
  const manifest = onlyManifest(runs);
  expect(manifest.status).toBe("failed");
  expect(manifest.resultPath).toBeUndefined();
});

test("runner finalizes a failed child with 30-day failure retention", async () => {
  const runs = root();
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: ["-e", "process.exit(4)"],
      timeoutMs: 2_000,
    }),
  ).toBe(4);
  expect(onlyManifest(runs)).toMatchObject({ status: "failed", retention: { class: "failure" } });
});

test("runner reaps a timed-out child and records the failure", async () => {
  const runs = root();
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30,
    }),
  ).toBe(1);
  const manifest = onlyManifest(runs);
  expect(manifest).toMatchObject({ status: "failed", retention: { class: "failure" } });
  const directory = join(runs, readdirSync(runs)[0]!);
  expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toMatchObject({
    timedOut: true,
  });
});

test("a child that exits zero after timeout SIGTERM still returns a failed command result", async () => {
  const runs = root();
  expect(
    await runWithVerificationLog({
      root: runs,
      owner: "integration",
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      timeoutMs: 30,
    }),
  ).toBe(1);
  expect(onlyManifest(runs)).toMatchObject({ status: "failed", retention: { class: "failure" } });
});

test("a parent SIGTERM reaps the runner child group and finalizes failed evidence", async () => {
  const runs = root();
  const ready = join(dirname(runs), "ready");
  const runner = new URL("../run-with-verification-log.ts", import.meta.url).href;
  const childProgram = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ready)}, "ready"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const wrapperProgram = `import { runWithVerificationLog } from ${JSON.stringify(runner)}; process.exit(await runWithVerificationLog({ root: ${JSON.stringify(runs)}, owner: "signal-test", command: process.execPath, args: ["-e", ${JSON.stringify(childProgram)}], timeoutMs: 10000 }));`;
  const wrapper = Bun.spawn(["bun", "-e", wrapperProgram], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForFile(ready);
  wrapper.kill("SIGTERM");
  expect(await wrapper.exited).toBe(1);
  expect(onlyManifest(runs)).toMatchObject({ status: "failed" });
  const directory = join(runs, readdirSync(runs)[0]!);
  expect(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).toMatchObject({
    parentInterrupted: true,
  });
});
