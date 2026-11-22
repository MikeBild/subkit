import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startOwnedChild } from "../../../../scripts/lib/owned-process-watchdog.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { TEST_MASTER_KEY, testEnv } from "../test-helpers/determinism/env.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";

let testDb: TestDb;
let configDir: string;

beforeAll(async () => {
  testDb = await createTestDb("source_boot");
  configDir = mkdtempSync(join(tmpdir(), "subkit-source-boot-"));
}, 120_000);

afterAll(async () => {
  rmSync(configDir, { recursive: true, force: true });
  await testDb.cleanup();
}, 120_000);

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

test("source engine boots worker, scheduler and HTTP, then shuts down on SIGTERM", async () => {
  const repo = resolve(import.meta.dir, "../../../..");
  const port = await freePort();
  const owned = startOwnedChild(
    process.execPath,
    [
      "--no-install",
      `--tsconfig-override=${resolve(repo, "tsconfig.json")}`,
      resolve(repo, "apps/engine/src/index.ts"),
    ],
    {
      cwd: repo,
      env: {
        ...testEnv,
        NODE_ENV: "test",
        LLM_PROVIDER: "mock",
        DATABASE_URL: testDb.url,
        MASTER_KEY: TEST_MASTER_KEY,
        PORT: String(port),
        SUBKIT_CONFIG: join(configDir, "subkit.config.json"),
        OTEL_SDK_DISABLED: "true",
        NO_UPDATE_CHECK: "1",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
    90_000,
    1_000,
  );
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-512_000);
  };
  owned.child.stdout?.on("data", collect);
  owned.child.stderr?.on("data", collect);

  await waitFor(() => output.includes('"action":"ready"'), {
    tries: 600,
    sleepMs: 100,
    label: "engine ready",
  });
  expect(output).toContain('"action":"consumer.installed"');
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  expect(health.status).toBe(200);

  owned.child.kill("SIGTERM");
  const result = await owned.completed;
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain('"action":"shutdown.complete"');
}, 120_000);
