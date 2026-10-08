import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv | null = null;

beforeAll(async () => {
  if (SKIP_PTY) return;
  env = await boot("sk-overhaul-cold-start", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  if (env) await shutdown(env);
}, 30_000);

describe("e2e: sk cold start", () => {
  test.skipIf(SKIP_PTY)(
    "banner renders within the cold-start budget",
    async () => {
      if (!env) throw new Error("env not booted");
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "banner" },
          { kind: "send", text: "\x04" },
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
      expect(r.visible.toLowerCase()).toMatch(/__match__|quick|sk/i);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "Ctrl+C cancels and exits clean",
    async () => {
      if (!env) throw new Error("env not booted");
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "banner" },
          { kind: "ready" },
          { kind: "send", text: "\x03" },
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );
});
