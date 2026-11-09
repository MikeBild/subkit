import { expect, test } from "bun:test";
import { startOwnedChild, terminateOwnedProcessGroup } from "./owned-process-watchdog.ts";

function waitForReady(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("child readiness timed out")), 3_000);
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes("ready:")) return;
      clearTimeout(timeout);
      resolve(output);
    });
    stream.once("error", reject);
  });
}

test("terminates the owned process group before falling back to its direct child", () => {
  const calls: Array<[number, NodeJS.Signals]> = [];
  let direct = 0;
  terminateOwnedProcessGroup(
    { pid: 42, kill: () => (direct += 1) } as never,
    "SIGTERM",
    (pid, signal) => calls.push([pid, signal]),
  );
  expect(calls).toEqual(process.platform === "win32" ? [] : [[-42, "SIGTERM"]]);
  expect(direct).toBe(process.platform === "win32" ? 1 : 0);
});

test("falls back to the owned child when group signalling fails", () => {
  let directSignal: NodeJS.Signals | undefined;
  terminateOwnedProcessGroup(
    { pid: 42, kill: (signal: NodeJS.Signals) => (directSignal = signal) } as never,
    "SIGKILL",
    () => {
      throw new Error("process group is already gone");
    },
  );
  expect(directSignal).toBe("SIGKILL");
});

test.skipIf(process.platform === "win32")(
  "reaps a stubborn child group and closes inherited pipes after its grace period",
  async () => {
    const grandchild = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
    const parent = `process.on("SIGTERM", () => {}); Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchild)}], { stdout: "inherit", stderr: "inherit" }); process.stdout.write("ready:group\\n"); setInterval(() => {}, 1_000);`;
    const owned = startOwnedChild(
      process.execPath,
      ["-e", parent],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
      3_000,
      50,
    );
    const ready = waitForReady(owned.child.stdout!);
    owned.child.stderr?.resume();
    await ready;
    const started = performance.now();
    owned.stop();
    let completed = false;
    try {
      const result = await Promise.race([
        owned.completed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watchdog completion hung")), 3_000),
        ),
      ]);
      completed = true;
      expect(result.timedOut).toBe(false);
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      if (!completed) owned.stop();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "waits through grace and kills a pipe-independent grandchild after its parent closes",
  async () => {
    const shell = "trap '' TERM; echo ready:$$; exec 1>&- 2>&-; while :; do sleep 1; done";
    const parent = `import { spawn } from "node:child_process"; const child = spawn("/bin/sh", ["-c", ${JSON.stringify(shell)}], { stdio: ["ignore", "pipe", "ignore"] }); child.stdout.on("data", (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1_000);`;
    const owned = startOwnedChild(
      process.execPath,
      ["-e", parent],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
      3_000,
      80,
    );
    const ready = waitForReady(owned.child.stdout!);
    owned.child.stderr?.resume();
    const grandchildPid = await ready;
    const started = performance.now();
    owned.stop();
    let completed = false;
    try {
      const result = await Promise.race([
        owned.completed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watchdog completion hung")), 3_000),
        ),
      ]);
      completed = true;
      expect(result.timedOut).toBe(false);
      expect(performance.now() - started).toBeGreaterThanOrEqual(75);
      const pid = Number.parseInt(grandchildPid.slice("ready:".length), 10);
      expect(Number.isInteger(pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (!completed) terminateOwnedProcessGroup(owned.child, "SIGKILL");
    }
  },
);
