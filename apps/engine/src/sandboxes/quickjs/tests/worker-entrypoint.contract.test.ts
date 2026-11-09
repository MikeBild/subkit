import { expect, test } from "bun:test";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const entry = join(root, "src/index.ts");

function nextMessage(child: ReturnType<typeof fork>, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // allow-wall-clock: watchdog bounds real subprocess IPC; a frozen clock cannot stop a hung child.
    const timeout = setTimeout(() => finish(new Error(`${label} timed out`)), 20_000);
    const message = (value: unknown) => finish(undefined, value);
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timeout);
      child.off("message", message);
      child.off("error", failed);
      if (error) reject(error);
      else resolve(value);
    };
    child.once("message", message);
    child.once("error", failed);
  });
}

async function stop(child: ReturnType<typeof fork>): Promise<void> {
  if (child.connected) {
    try {
      child.disconnect();
    } catch {}
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

test("production engine entry starts the QuickJS IPC worker", async () => {
  const child = fork(entry, ["--sandbox-worker"], {
    cwd: root,
    execPath: process.execPath,
    execArgv: ["--no-install"],
    env: { ...process.env, NODE_ENV: "test", OTEL_SDK_DISABLED: "true" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const ready = await nextMessage(child, "QuickJS worker readiness");
    expect(ready).toEqual({ ready: true });
    const responsePromise = nextMessage(child, "QuickJS worker response");
    child.send({
      id: 1,
      body: { op: "run_js", opts: { code: "return 21 * 2;", input: null, clock: null } },
    });
    const response = await responsePromise;
    expect(response).toMatchObject({ id: 1, ok: true, result: { output: 42 } });
  } finally {
    await stop(child);
  }
}, 45_000);
