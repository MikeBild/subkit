import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { startOwnedChild } from "../../../../scripts/lib/owned-process-watchdog.ts";

test("source engine entry completes its real worker and redaction smoke path", async () => {
  const repo = resolve(import.meta.dir, "../../../..");
  const owned = startOwnedChild(
    process.execPath,
    [
      "--no-install",
      `--tsconfig-override=${resolve(repo, "tsconfig.json")}`,
      resolve(repo, "apps/engine/src/index.ts"),
      "--smoke",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        NODE_ENV: "test",
        LLM_PROVIDER: "mock",
        OTEL_SDK_DISABLED: "true",
        NO_UPDATE_CHECK: "1",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
    30_000,
    1_000,
  );
  let output = "";
  owned.child.stdout?.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-128_000);
  });
  owned.child.stderr?.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-128_000);
  });
  const result = await owned.completed;
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("smoke.quickjs_ok");
  expect(output).toContain("smoke.completed");
  expect(output).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
}, 40_000);
