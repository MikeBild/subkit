import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
child.stdout.on("data", (chunk) => sink.append(chunk, "stdout"));
child.stderr.on("data", (chunk) => sink.append(chunk, "stderr"));
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

test("retains stderr diagnostics when stdout floods after the error", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-bounded-output-streams-"));
  try {
    const log = join(root, "runner.log");
    writeFileSync(log, "", { mode: 0o600, flag: "wx" });
    const sink = createBoundedOutputLog(log, 1024, 64);
    sink.append(Buffer.from("failure-tail"), "stderr");
    sink.append(Buffer.from("x".repeat(4096)), "stdout");
    const output = sink.snapshot();
    expect(output.totalBytes).toBe(4096 + Buffer.byteLength("failure-tail"));
    expect(output.persistedBytes).toBe(1024);
    expect(output.truncated).toBe(true);
    expect(readFileSync(log).byteLength).toBe(1024);
    expect(output.tail.toString()).toContain("failure-tail");
    expect(output.tail.toString()).toContain("x");
    expect(output.tail.byteLength).toBe(64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps bounded tails from both streams while donating unused stderr space to stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-bounded-output-streams-"));
  try {
    const log = join(root, "runner.log");
    writeFileSync(log, "", { mode: 0o600, flag: "wx" });
    const sink = createBoundedOutputLog(log, 4096, 64);
    sink.append(Buffer.from(`${"o".repeat(128)}stdout-tail`), "stdout");
    sink.append(Buffer.from(`${"e".repeat(128)}stderr-tail`), "stderr");
    const both = sink.snapshot().tail;
    expect(both.toString()).toContain("stdout-tail");
    expect(both.toString()).toContain("stderr-tail");
    expect(both.byteLength).toBeLessThanOrEqual(64);

    const stdoutOnly = createBoundedOutputLog(join(root, "stdout.log"), 4096, 64);
    stdoutOnly.append(Buffer.from("x".repeat(128)), "stdout");
    expect(stdoutOnly.snapshot().tail.byteLength).toBe(64);

    const stderrOnly = createBoundedOutputLog(join(root, "stderr.log"), 4096, 64);
    stderrOnly.append(Buffer.from("e".repeat(128)), "stderr");
    expect(stderrOnly.snapshot().tail.byteLength).toBe(64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses the one-byte tail for stderr when both streams are present", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-bounded-output-streams-"));
  try {
    const log = join(root, "runner.log");
    writeFileSync(log, "", { mode: 0o600, flag: "wx" });
    const sink = createBoundedOutputLog(log, 16, 1);
    sink.append(Buffer.from("x"), "stdout");
    sink.append(Buffer.from("E"), "stderr");
    expect(sink.snapshot().tail.toString()).toBe("E");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
