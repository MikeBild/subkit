import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { conversations } from "../../apps/engine/src/db/schema/conversations.ts";
import type { ExpectStep } from "./_helpers/pty.ts";
import { ptyFailureDiagnostic, runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { quickStartReady } from "./_helpers/pty-steps.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("repl-agent-briefing", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function typeLine(text: string): ExpectStep[] {
  return [
    { kind: "send", text },
    { kind: "wait", pattern: text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
    { kind: "send", text: "\r" },
  ];
}

describe("subkit interactive REPL briefing", () => {
  test.skipIf(SKIP_PTY)(
    "injects the folder briefing as conversation memory in a real PTY session",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "billing-"));
      const debugFile = path.join(cwd, "debug.log");
      mkdirSync(path.join(cwd, ".subkit"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".subkit", "agent.json"),
        JSON.stringify({ domains: ["subkit"] }),
      );
      try {
        const result = await runPtyScenario(
          [
            quickStartReady(),
            { kind: "ready" },
            ...typeLine("Please summarize what SubKit can help with."),
            {
              kind: "wait-file",
              file: debugFile,
              pattern: '"kind":"dialog.turn_end"[^\n]*"input_kind":"prompt"',
              count: 1,
            },
            ...typeLine("/clear"),
            {
              kind: "wait-file",
              file: debugFile,
              pattern: '"kind":"dialog.turn_end"[^\n]*"name":"clear"',
              count: 1,
            },
            ...typeLine("Summarize the SubKit context again."),
            {
              kind: "wait-file",
              file: debugFile,
              pattern: '"kind":"dialog.turn_end"[^\n]*"input_kind":"prompt"',
              count: 2,
            },
            ...typeLine("/exit"),
          ],
          {
            persona: env.personas.admin,
            engineUrl: env.baseUrl,
            cwd,
            env: { SUBKIT_DEBUG: "1", SUBKIT_DEBUG_FILE: debugFile },
          },
        );
        expect(result.exitCode, ptyFailureDiagnostic(result)).toBe(0);
        expect(result.visible).not.toContain("HTTP 500");
        const records = readFileSync(debugFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const briefingRequest = records.find(
          (record) =>
            record.kind === "http.request" &&
            record.path === "/v1/agent/briefing" &&
            typeof record.request_body === "object",
        );
        expect(briefingRequest).toBeDefined();
        const conversationRequests = records.filter(
          (record) =>
            record.kind === "http.request" &&
            record.path === "/v1/conversations" &&
            record.method === "POST",
        );
        expect(conversationRequests).toHaveLength(2);
        for (const conversationRequest of conversationRequests) {
          const body = conversationRequest.request_body as Record<string, unknown>;
          expect(body.memory).toBeString();
          expect(body.memory).not.toBe("");
        }
        const conversationIds = records
          .filter(
            (record) =>
              record.kind === "dialog.turn_end" &&
              record.input_kind === "prompt" &&
              typeof record.conversation_id === "string",
          )
          .map((record) => record.conversation_id as string);
        expect(conversationIds).toHaveLength(2);
        for (const conversationId of conversationIds) {
          const [stored] = await env.db
            .select({ memory: conversations.memory })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);
          expect(stored?.memory).toContain("## Open-ended workspace questions");
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    50_000,
  );
});
