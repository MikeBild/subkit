import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { runPtyScenario, SKIP_PTY_WHEN_NO_EXPECT } from "../e2e/_helpers/pty.ts";
import { exit, quickStartReady } from "../e2e/_helpers/pty-steps.ts";
import { collectContainerLogs, type DockerEnv, dockerBoot } from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

afterAll(() => {
  collectContainerLogs(path.resolve(import.meta.dir, "../../engine-docker-repl.log"));
}, 60_000);

const HOME = path.resolve(import.meta.dir, "../../.docker-repl-home");

describe("sk REPL against the container", () => {
  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "boots to the quick-start banner over a PTY and exits cleanly",
    async () => {
      const result = await runPtyScenario([quickStartReady(), exit()], {
        engineUrl: env.baseUrl,
        env: {
          SUBKIT_API_KEY: env.adminKey,
          SUBKIT_ENGINE_URL: env.baseUrl,
          HOME,
          XDG_CONFIG_HOME: HOME,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.visible).not.toContain("HTTP 500");
      expect(result.visible).not.toContain("internal_error");
    },
    60_000,
  );
});
