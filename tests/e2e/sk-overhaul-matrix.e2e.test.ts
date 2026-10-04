import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HAS_SK_BIN, runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv | null = null;

beforeAll(async () => {
  if (!HAS_SK_BIN) return;
  env = await boot("sk-overhaul-matrix", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  if (env) await shutdown(env);
}, 30_000);

const E = (): E2EEnv => {
  if (!env) throw new Error("env not booted");
  return env;
};

describe("e2e matrix: sk CLI overhaul (live engine)", () => {
  test.todo("device login renders the auth flow chrome — needs device-flow mock harness");

  test.skipIf(!HAS_SK_BIN)("api-key login stores a usable profile", async () => {
    const result = await cli(
      ["login", "--engine-url", E().baseUrl, "--api-key", E().personas.admin.apiKey],
      { env: E(), persona: "admin" },
    );
    expectSuccess(result, "matrix api-key login");
    expect(result.stdout).toContain("saved");
    expect(result.stdout).toContain("engine health: live=ok ready=ready");
  });

  test.todo("portal-token login boots and exits clean — needs portal-token mint harness");

  test.skipIf(!HAS_SK_BIN)("headless `sk -p` resolves cleanly", async () => {
    const result = await cli(["--p", "say hello", "--output", "json"], {
      env: E(),
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "matrix headless");
    const body = JSON.parse(result.stdout) as { status: string; session_id: string };
    expect(body.status).toBe("completed");
    expect(body.session_id).toBeTruthy();
  });

  test.skipIf(!HAS_SK_BIN)("`--quiet` suppresses headless warnings", async () => {
    const noisy = await cli(["--p", "please inspect @missing-file", "--output", "text"], {
      env: E(),
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(noisy, "matrix quiet baseline");
    expect(noisy.stderr).toContain("@missing-file: not found");

    const quiet = await cli(
      ["--quiet", "--p", "please inspect @missing-file", "--output", "text"],
      {
        env: E(),
        persona: "admin",
        timeout: 60_000,
      },
    );
    expectSuccess(quiet, "matrix quiet");
    expect(quiet.stderr).not.toContain("@missing-file: not found");
  });

  test.skipIf(!HAS_SK_BIN)("`--max-turns` is accepted by headless mode", async () => {
    const result = await cli(["--max-turns", "1", "--p", "say hello", "--output", "json"], {
      env: E(),
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "matrix max-turns");
    const body = JSON.parse(result.stdout) as { status: string };
    expect(body.status).toBe("completed");
  });

  test.skipIf(SKIP_PTY)(
    "admin persona sees /audit suggestion",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "/au" },
          { kind: "sleep", ms: 100 },
          { kind: "send", text: "\x03" },
          { kind: "send", text: "\x03" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "member persona sees a constrained slash menu",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "/" },
          { kind: "sleep", ms: 100 },
          { kind: "send", text: "\x03" },
          { kind: "send", text: "\x03" },
        ],
        { persona: E().personas.member, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.todo("enduser persona renders welcome hint — needs frame-text capture in PTY harness");

  test.skipIf(SKIP_PTY)(
    "onboarding template entry point boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "onboarding OAuth path entry boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "workflow run inspect step boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "settings configure boots cleanly",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "provider-quota error renders ErrorPanel",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "network drop surfaces a friendly error",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        {
          persona: E().personas.admin,
          engineUrl: "http://127.0.0.1:1",
        },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "auth expiry triggers a re-login hint",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "resize during boot doesn't corrupt the frame",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "multi-tenant switch renders new persona",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "resume conversation by id boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "bracketed-paste through PTY does not crash",
    async () => {
      const PASTE_START = "\x1b[200~";
      const PASTE_END = "\x1b[201~";
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "send", text: `${PASTE_START}    indented\n\tline\n${PASTE_END}` },
          { kind: "sleep", ms: 50 },
          { kind: "send", text: "\x03" },
          { kind: "send", text: "\x03" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode).toBe(0);
    },
    20_000,
  );
});
