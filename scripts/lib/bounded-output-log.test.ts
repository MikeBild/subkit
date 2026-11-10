import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createBoundedOutputLog } from "./bounded-output-log.ts";

const execFileAsync = promisify(execFile);
const node = Bun.which("node");
const bun = Bun.which("bun");

async function runThroughDefaultNodeExec(source: string): Promise<Record<string, unknown>> {
  if (!node || !bun) throw new Error("node and bun are required");
  const root = mkdtempSync(join(tmpdir(), "subkit-node-exec-fixture-"));
  const fixture = join(root, "fixture.ts");
  writeFileSync(fixture, source, { mode: 0o600, flag: "wx" });
  const command = `${JSON.stringify(bun)} ${JSON.stringify(fixture)}`;
  try {
    const outer = await execFileAsync(
      node,
      [
        "-e",
        "require('node:child_process').exec(process.env.SUBKIT_CAPTURE_FIXTURE, (error, stdout, stderr) => { if (error) { process.stderr.write(stderr); process.exit(1); } process.stdout.write(stdout); });",
      ],
      { env: { ...process.env, SUBKIT_CAPTURE_FIXTURE: command } },
    );
    return JSON.parse(outer.stdout.trim()) as Record<string, unknown>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function streamingFixture(childSource: string): string {
  const module = JSON.stringify(resolve(import.meta.dir, "bounded-output-log.ts"));
  const child = JSON.stringify(childSource);
  return `
const { createBoundedOutputLog } = await import(${module});
const { spawn } = await import("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const root = mkdtempSync(join(tmpdir(), "subkit-node-exec-capture-"));
const log = join(root, "runner.log");
writeFileSync(log, "", { mode: 0o600, flag: "wx" });
const sink = createBoundedOutputLog(log, 1024 * 1024, 64 * 1024);
const child = spawn(${JSON.stringify(node)}, ["-e", ${child}], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => sink.append(chunk));
child.stderr.on("data", (chunk) => sink.append(chunk));
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (value) => resolve(value ?? 1)); });
const output = sink.snapshot();
console.log(JSON.stringify({ code, totalBytes: output.totalBytes, persistedBytes: output.persistedBytes, truncated: output.truncated, tail: output.tail.toString(), logBytes: readFileSync(log).byteLength }));
rmSync(root, { recursive: true, force: true });
`;
}

function timeoutFixture(): string {
  const module = JSON.stringify(resolve(import.meta.dir, "owned-process-watchdog.ts"));
  return `
const { startOwnedChild } = await import(${module});
const child = startOwnedChild(${JSON.stringify(node)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] }, 25, 25);
const outcome = await child.completed;
console.log(JSON.stringify(outcome));
`;
}

test("passes more than two MiB through a real node default exec boundary", async () => {
  const result = await runThroughDefaultNodeExec(
    streamingFixture(
      "process.stdout.write('a'.repeat(1200000));process.stderr.write('b'.repeat(1200000));",
    ),
  );
  expect(result.code).toBe(0);
  expect(result.totalBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(result.persistedBytes).toBe(1024 * 1024);
  expect(result.truncated).toBe(true);
  expect(result.logBytes).toBe(1024 * 1024);
});

test("preserves a failing noisy command with a bounded diagnostic tail through node exec", async () => {
  const result = await runThroughDefaultNodeExec(
    streamingFixture(
      "process.stdout.write('x'.repeat(2400000));process.stderr.write('failure-tail');process.exitCode=7;",
    ),
  );
  expect(result.code).toBe(7);
  expect(result.truncated).toBe(true);
  expect(String(result.tail)).toContain("failure-tail");
  expect(Buffer.byteLength(String(result.tail))).toBeLessThanOrEqual(64 * 1024);
});

test("reports a timed out owned child through the real node exec boundary", async () => {
  const result = await runThroughDefaultNodeExec(timeoutFixture());
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
});

test("fails closed when the owned log sink cannot append", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-bounded-output-"));
  try {
    const sink = createBoundedOutputLog(join(root, "missing", "runner.log"));
    expect(() => sink.append(Buffer.from("output"))).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
