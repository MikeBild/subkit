import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { testEnv } from "../test-helpers/determinism/env.ts";

const IMAGE =
  "chrislusf/seaweedfs@sha256:bb05d66d2963b1cc48073190781c3dd29e2c4c88a2ae2986bf58e38c86d89c6e";

const ACCESS_KEY = "subkit-fixture-key";
const SECRET_KEY = "subkit-fixture-secret";
const IDENTITIES = JSON.stringify({
  identities: [
    {
      name: "fixture",
      credentials: [{ accessKey: ACCESS_KEY, secretKey: SECRET_KEY }],
      actions: ["Admin", "Read", "Write", "List", "Tagging"],
    },
  ],
});

export interface ObjectStoreFixture {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

export async function dockerAvailable(): Promise<boolean> {
  if (testEnv.SKIP_DOCKER === "1") return false;
  const { spawnSync } = await import("node:child_process");
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export async function startObjectStore(namePrefix: string): Promise<ObjectStoreFixture> {
  const name = `${namePrefix}-${Math.random().toString(36).slice(2, 8)}`; // allow-random: unique container name per run
  const storageRoot = testEnv.SUBKIT_TEST_OBJECT_STORE_ROOT;
  let dataDirectory: string | undefined;
  if (storageRoot) {
    const root = resolve(storageRoot);
    mkdirSync(root, { recursive: true });
    dataDirectory = mkdtempSync(join(root, "object-store-"));
  }
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      ...(dataDirectory ? ["--volume", `${dataDirectory}:/data`] : []),
      "-p",
      "0:9000",
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      `printf '%s' '${IDENTITIES}' > /etc/s3.json && exec weed server -dir=/data -s3 -s3.port=9000 -s3.config=/etc/s3.json`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const containerId = (await new Response(proc.stdout).text()).trim();
  if (!containerId) {
    const errText = await new Response(proc.stderr).text();
    if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
    throw new Error(`object store fixture did not start: ${errText}`);
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    const removed = Bun.spawnSync(["docker", "rm", "-f", containerId]);
    if (removed.exitCode !== 0) throw new Error("object store fixture cleanup failed");
    stopped = true;
    if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
  };

  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) {
    await stop();
    throw new Error("object store fixture published no port");
  }

  // allow-wall-clock: container warm-up poll before the first request. The
  // server elects a leader before it serves, which takes tens of seconds on a
  // cold start — a deadline tuned to a faster server is how this flakes.
  const deadline = Date.now() + 90_000;
  let authenticating = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 403) {
        authenticating = true;
        break;
      }
      if (res.ok) {
        await stop();
        throw new Error("object store fixture accepted an unsigned request; identities not loaded");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("unsigned request")) throw error;
    }
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: fixture warm-up
  }
  if (!authenticating) {
    await stop();
    throw new Error("object store fixture did not become ready within 90 seconds");
  }

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    stop,
  };
}
