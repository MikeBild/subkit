import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createLocalCliOAuthBrowser,
  LOCAL_CLI_OAUTH_BROWSER_SUPPORTED,
} from "./_helpers/local-cli-oauth-browser.ts";
import { HAS_SK_BIN, ptyFailureDiagnostic, runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
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

const savedProfileEnv = { SUBKIT_API_KEY: "", SUBKIT_TENANT: "" };

function savedDefaultProfile(homeDir: string): { api_key?: string; portal_locked?: boolean } {
  const config = JSON.parse(readFileSync(path.join(homeDir, ".sk", "config.json"), "utf8")) as {
    profiles?: Record<string, { api_key?: string; portal_locked?: boolean }>;
  };
  return config.profiles?.default ?? {};
}

describe("e2e matrix: sk CLI overhaul (live engine)", () => {
  test.skipIf(!HAS_SK_BIN || !LOCAL_CLI_OAUTH_BROWSER_SUPPORTED)(
    "OAuth authorization-code login authenticates the compiled CLI through a POSIX local browser flow",
    async () => {
      const browser = createLocalCliOAuthBrowser({
        engineUrl: E().baseUrl,
        apiKey: E().personas.admin.apiKey,
      });
      try {
        const login = await cli(["login", "--engine-url", E().baseUrl, "--tenant", E().tenantId], {
          env: E(),
          persona: "admin",
          extraEnv: browser.env,
          timeout: 90_000,
        });
        expectSuccess(login, "local OAuth authorization-code login");
        expect(login.stdout).toContain("signed in as");
        expect(login.stdout).toContain("profile 'default' saved");
        const profile = savedDefaultProfile(E().personas.admin.homeDir);
        expect(Boolean(profile.api_key && profile.api_key !== E().personas.admin.apiKey)).toBe(
          true,
        );

        const authenticated = await cli(["workflows", "list"], {
          env: E(),
          persona: "admin",
          extraEnv: savedProfileEnv,
        });
        expectSuccess(authenticated, "OAuth-issued CLI profile workflows list");
      } finally {
        browser.cleanup();
      }
    },
    120_000,
  );

  test.skipIf(!HAS_SK_BIN)("api-key login stores a usable profile", async () => {
    const result = await cli(
      ["login", "--engine-url", E().baseUrl, "--api-key", E().personas.admin.apiKey],
      { env: E(), persona: "admin" },
    );
    expectSuccess(result, "matrix api-key login");
    expect(result.stdout).toContain("saved");
    expect(result.stdout).toContain("engine health: live=ok ready=ready");
  });

  test.skipIf(!HAS_SK_BIN)(
    "minted portal token creates a locked compiled-CLI profile and rejects tenant switching",
    async () => {
      const issued = await fetch(`${E().baseUrl}/v1/identity/portal-tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${E().personas.admin.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          user_id: E().personas.enduser.userId,
          allowed_workflows: ["portal-matrix-workflow"],
          ttl_minutes: 10,
        }),
      });
      expect(issued.status).toBe(201);
      const portal = (await issued.json()) as { plaintext_token?: string };
      expect(portal.plaintext_token).toBeTruthy();

      const login = await cli(
        ["login", "--portal-token", portal.plaintext_token ?? "", "--engine-url", E().baseUrl],
        { env: E(), persona: "enduser" },
      );
      expectSuccess(login, "minted portal-token login");
      expect(login.stdout).toContain("tenant locked");
      const profile = savedDefaultProfile(E().personas.enduser.homeDir);
      expect(Boolean(profile.api_key && profile.api_key === portal.plaintext_token)).toBe(true);
      expect(profile.portal_locked).toBe(true);

      const status = await cli(["status"], {
        env: E(),
        persona: "enduser",
        extraEnv: savedProfileEnv,
      });
      expectSuccess(status, "portal profile status");
      expect(status.stdout).toContain("portal_lock  yes");

      const portalWorkflows = await cli(["workflows", "list"], {
        env: E(),
        persona: "enduser",
        extraEnv: savedProfileEnv,
      });
      expect(portalWorkflows.exitCode).toBe(2);
      expect(portalWorkflows.stderr).toContain("forbidden: workflow_not_in_allowlist");

      const switchTenant = await cli(["tenants", "other-tenant"], {
        env: E(),
        persona: "enduser",
        extraEnv: savedProfileEnv,
      });
      expect(switchTenant.exitCode).toBe(2);
      expect(switchTenant.stderr).toContain("cannot switch tenants as a portal-token user");
    },
  );

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
          { kind: "ready" },
          { kind: "send", text: "/au" },
          { kind: "sleep", ms: 100 },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "member persona sees a constrained slash menu",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "/" },
          { kind: "sleep", ms: 100 },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.member, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "enduser persona renders its real welcome frame without the admin tenant-inspection action",
    async () => {
      const result = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "enduser welcome" },
          { kind: "ready" },
          { kind: "send", text: "\u0004" },
        ],
        { persona: E().personas.enduser, engineUrl: E().baseUrl },
      );
      expect(result.exitCode, ptyFailureDiagnostic(result)).toBe(0);
      const visible = result.visible.replace(/\s+/g, " ");
      expect(visible).toContain("enduser");
      expect(visible).toContain("Resume work, create a connector");
      expect(visible).not.toContain("Inspect tenant state");
    },
    40_000,
  );

  test.skipIf(SKIP_PTY)(
    "onboarding template entry point boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "onboarding OAuth path entry boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "workflow run inspect step boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "settings configure boots cleanly",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "provider-quota error renders ErrorPanel",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "network drop surfaces a friendly error",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        {
          persona: E().personas.admin,
          engineUrl: "http://127.0.0.1:1",
        },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "auth expiry triggers a re-login hint",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "resize during boot doesn't corrupt the frame",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "multi-tenant switch renders new persona",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );

  test.skipIf(SKIP_PTY)(
    "resume conversation by id boots",
    async () => {
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "ready" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
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
          { kind: "ready" },
          { kind: "send", text: `${PASTE_START}    indented\n\tline\n${PASTE_END}` },
          { kind: "sleep", ms: 50 },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: E().personas.admin, engineUrl: E().baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
    },
    20_000,
  );
});
