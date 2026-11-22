import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ExpectStep, runPtyScenario } from "./_helpers/pty.ts";
import { boot, cli, type E2EEnv, parseJson, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("subkit-interactive-smoke", { llm: "mock" });
}, 90000);
afterAll(async () => {
  await shutdown(env);
}, 30000);
const EXPECT_BIN = Bun.which("expect");
async function runInteractiveScenario(
  steps: readonly ExpectStep[],
  debugFile?: string,
  args?: readonly string[],
): Promise<string> {
  const result = await runPtyScenario(steps, {
    persona: env.personas.admin,
    engineUrl: env.baseUrl,
    ...(debugFile ? { env: { SUBKIT_DEBUG_FILE: debugFile } } : {}),
    ...(args ? { args } : {}),
  });
  expect(result.exitCode).toBe(0);
  return result.visible.replace(/\s+/g, " ");
}
const SUBKIT_RUN_STARTER_E2E = process.env.SUBKIT_RUN_STARTER_E2E === "1";
const skipStarter = !SUBKIT_RUN_STARTER_E2E;

describe("subkit interactive smoke", () => {
  test.skipIf(skipStarter)(
    "resumes a persisted confirmation in the PTY and submits the answer",
    async () => {
      if (!EXPECT_BIN) return;
      const created = await cli(["--p", "subkit engine onboarding", "--output", "json"], {
        env,
        persona: "admin",
        timeout: 120_000,
      });
      expect(created.exitCode).toBe(0);
      const result = parseJson<{
        session_id: string;
        status: string;
        pending_elicitation?: { id: string; tool_name: string };
      }>(created);
      expect(result.status).toBe("awaiting_input");
      expect(result.pending_elicitation?.tool_name).toBe("ask_user_confirm");
      const detailResponse = await fetch(`${env.baseUrl}/v1/conversations/${result.session_id}`, {
        headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
      });
      expect(detailResponse.status).toBe(200);
      const detail = (await detailResponse.json()) as {
        resume_summary?: { pending_approval?: { prompt?: { question?: string } } | null };
      };
      const question = detail.resume_summary?.pending_approval?.prompt?.question;
      expect(question).toBeTruthy();

      const debugDir = mkdtempSync(path.join(tmpdir(), "subkit-resume-elicit-"));
      const debugFile = path.join(debugDir, "debug.log");
      try {
        const pty = await runPtyScenario(
          [
            { kind: "wait", pattern: "confirm:" },
            { kind: "sleep", ms: 500 },
            { kind: "send", text: "y" },
            { kind: "sleep", ms: 7000 },
            { kind: "send", text: "\u0004" },
          ],
          {
            persona: env.personas.admin,
            engineUrl: env.baseUrl,
            env: { SUBKIT_DEBUG_FILE: debugFile },
            unsetEnv: ["CI", "CONTINUOUS_INTEGRATION"],
            args: ["--session-id", result.session_id],
          },
        );
        const visible = pty.visible.replace(/\s+/g, " ");
        if (pty.exitCode !== 0) {
          throw new Error(
            `PTY exit ${pty.exitCode}; stderr=${pty.stderr}; visible=${pty.visible.slice(-5000)}; raw=${JSON.stringify(pty.raw.slice(-5000))}; debug=${readFileSync(debugFile, "utf8")}`,
          );
        }
        expect(visible).toContain("confirm:");
        expect(visible).toContain(question!);

        const records = readFileSync(debugFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind?: string; method?: string; path?: string });
        expect(
          records.some(
            (record) =>
              record.kind === "http.request" &&
              record.method === "POST" &&
              record.path ===
                `/v1/conversations/${result.session_id}/elicitations/${result.pending_elicitation?.id}/respond`,
          ),
        ).toBe(true);

        const resolvedResponse = await fetch(
          `${env.baseUrl}/v1/conversations/${result.session_id}`,
          { headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` } },
        );
        const resolved = (await resolvedResponse.json()) as {
          conversation: { status: string };
          resume_summary?: { pending_approval?: unknown };
        };
        expect(resolved.conversation.status).not.toBe("awaiting_input");
        expect(resolved.resume_summary?.pending_approval ?? null).toBeNull();
      } finally {
        rmSync(debugDir, { recursive: true, force: true });
      }
    },
    150_000,
  );

  test.skipIf(skipStarter)(
    "shows and persists the selected profile in a real PTY session",
    async () => {
      if (!EXPECT_BIN) return;
      const home = mkdtempSync(path.join(tmpdir(), "subkit-profile-switch-"));
      mkdirSync(path.join(home, ".subkit"), { recursive: true });
      const configPath = path.join(home, ".subkit", "config.json");
      const debugFile = path.join(home, "debug.log");
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            active_profile: "default",
            profiles: {
              default: {
                engine_url: env.baseUrl,
                api_key: env.personas.admin.apiKey,
                active_tenant_id: env.tenantId,
                persona_hint: "admin",
              },
              member: {
                engine_url: env.baseUrl,
                api_key: env.personas.member.apiKey,
                active_tenant_id: env.tenantId,
                persona_hint: "member",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      try {
        const result = await runPtyScenario(
          [
            { kind: "wait", pattern: "Resume work, create a connector" },
            { kind: "ready" },
            { kind: "send", text: "/profile member" },
            { kind: "sleep", ms: 100 },
            { kind: "send", text: "\r" },
            { kind: "wait", pattern: "profile member" },
            { kind: "terminate" },
          ],
          {
            engineUrl: env.baseUrl,
            env: {
              HOME: home,
              XDG_CONFIG_HOME: home,
              SUBKIT_DEBUG_FILE: debugFile,
              SUBKIT_API_KEY: "",
              SUBKIT_TENANT: "",
            },
            unsetEnv: ["CI", "CONTINUOUS_INTEGRATION"],
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `PTY exit ${result.exitCode}; stderr=${result.stderr.slice(0, 1200)}; visible=${result.visible.slice(-5000)}; debug=${readFileSync(debugFile, "utf8")}`,
          );
        }
        expect(result.visible).toContain("profile member");
        const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
          active_profile: string;
        };
        expect(saved.active_profile).toBe("member");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test.skipIf(skipStarter)(
    "boots through whoami + RBAC + status without surfacing the startup 500 banner",
    async () => {
      if (!EXPECT_BIN) return;
      const visible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector", label: "quick-start" },
        { kind: "sleep", ms: 1000 },
        { kind: "wait", pattern: "v", label: "banner" },
        { kind: "send", text: "\u0004" },
      ]);
      expect(visible).not.toContain("HTTP 500 internal_error");
      expect(visible).not.toContain("trace_id");
      expect(visible).toContain("session new");
    },
    40_000,
  );

  test.skipIf(skipStarter)(
    "starter action 2 seeds guided connector onboarding",
    async () => {
      const visible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector" },
        { kind: "sleep", ms: 1000 },
        { kind: "send", text: "2" },
        { kind: "sleep", ms: 500 },
        { kind: "send", text: "\u0004" },
      ]);
      expect(visible).toContain("I want to create a connector.");
      expect(visible).toContain("Suggest a template only if it clearly helps");
      expect(visible).toContain(
        "Ask me one high-signal question at a time and probe before saving.",
      );
    },
    40000,
  );
  test.skipIf(skipStarter)(
    "starter action 3 seeds guided workflow authoring",
    async () => {
      const visible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector" },
        { kind: "sleep", ms: 1000 },
        { kind: "send", text: "3" },
        { kind: "sleep", ms: 500 },
        { kind: "send", text: "\u0004" },
      ]);
      expect(visible).toContain("I want to build a workflow.");
      expect(visible).toContain("Preview before commit");
    },
    40000,
  );
  test.skipIf(skipStarter)(
    "starter action 4 seeds inspection of actual tenant resources",
    async () => {
      const visible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector" },
        { kind: "sleep", ms: 1000 },
        { kind: "send", text: "4" },
        { kind: "sleep", ms: 500 },
        { kind: "send", text: "\u0004" },
      ]);
      expect(visible).toContain("I want to inspect or manage existing tenant resources.");
      expect(visible).toContain(
        "Ground me in the workflows, connectors, runs, or credentials that actually exist first.",
      );
    },
    40000,
  );
  test.skipIf(skipStarter)(
    "starter action 5 seeds API and MCP surface guidance",
    async () => {
      const visible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector" },
        { kind: "sleep", ms: 1000 },
        { kind: "send", text: "5" },
        { kind: "sleep", ms: 500 },
        { kind: "send", text: "\u0004" },
      ]);
      expect(visible).toContain(
        "I want help using subkit surfaces - the CLI, MCP, the HTTP API, schedules, or Google Chat.",
      );
      expect(visible).toContain("Answer from actual engine behavior and exposed routes only.");
    },
    40000,
  );
  test.skipIf(skipStarter)(
    "starter action 1 opens the richer /resume browser and attaches to the picked conversation",
    async () => {
      if (!EXPECT_BIN) return;
      const create = await fetch(`${env.baseUrl}/v1/conversations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.personas.admin.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "interactive resume smoke" }),
      });
      expect(create.status).toBe(201);
      const body = (await create.json()) as { conversation: { id: string } };
      const shortId = body.conversation.id.slice(0, 8);
      const listed = await fetch(`${env.baseUrl}/v1/conversations?owner=me&limit=25`, {
        headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
      });
      expect(listed.status).toBe(200);
      const listing = (await listed.json()) as { items: Array<{ id: string; title: string }> };
      expect(listing.items.some((item) => item.id === body.conversation.id)).toBe(true);

      const browserVisible = await runInteractiveScenario([
        { kind: "wait", pattern: "Resume work, create a connector" },
        { kind: "sleep", ms: 1000 },
        { kind: "send", text: "1" },
        { kind: "sleep", ms: 1000 },
        { kind: "ready" },
        { kind: "send", text: "\u0004" },
      ]);
      expect(browserVisible.toLowerCase()).toContain("resume conversation");
      expect(browserVisible).toContain("interactive resume smoke");

      const debugFile = path.join(
        mkdtempSync(path.join(tmpdir(), "subkit-resume-review-")),
        "debug.log",
      );
      const visible = await runInteractiveScenario(
        [
          { kind: "wait", pattern: "Resume work, create a connector", label: "quick-start" },
          { kind: "sleep", ms: 1000 },
          { kind: "send", text: "1" },
          { kind: "sleep", ms: 1000 },
          { kind: "ready" },

          { kind: "send", text: "\r" },
          { kind: "sleep", ms: 1000 },
          { kind: "send", text: "synthetic resume verification" },
          { kind: "sleep", ms: 100 },
          { kind: "send", text: "\r" },
          { kind: "sleep", ms: 2000 },
          { kind: "send", text: "\u0004" },
        ],
        debugFile,
      );
      const records = readFileSync(debugFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        records.some(
          (record) =>
            record.kind === "http.request" &&
            record.method === "POST" &&
            record.path === `/v1/conversations/${body.conversation.id}/messages`,
        ),
      ).toBe(true);
      expect(visible).toContain(`session ${shortId}`);
    },
    40_000,
  );
});
