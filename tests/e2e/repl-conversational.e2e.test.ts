import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExpectStep } from "./_helpers/pty.ts";
import { runPtyScenario, SKIP_PTY_WHEN_NO_EXPECT } from "./_helpers/pty.ts";
import { quickStartReady } from "./_helpers/pty-steps.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("repl-conversational", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function typeLine(text: string): ExpectStep[] {
  return [
    { kind: "send", text },
    { kind: "sleep", ms: 100 },
    { kind: "send", text: "\r" },
  ];
}

function debugFile(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `sk-${name}-debug-`)), "debug.log");
}

function readDebug(pathname: string): Array<Record<string, unknown>> {
  return readFileSync(pathname, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function hasSlashCompletion(records: Array<Record<string, unknown>>, name: string): boolean {
  return records.some(
    (record) =>
      record.kind === "dialog.turn_end" &&
      record.input_kind === "slash" &&
      record.name === name &&
      record.status === "completed",
  );
}

function requestedPath(records: Array<Record<string, unknown>>, route: string): boolean {
  return records.some((record) => record.kind === "http.request" && record.path === route);
}

function succeededPath(records: Array<Record<string, unknown>>, route: string): boolean {
  return records.some(
    (record) =>
      record.kind === "http.response" &&
      record.path === route &&
      record.status === 200 &&
      record.ok === true,
  );
}

const SKIP_PTY_DISPATCH = process.env.SUBKIT_RUN_PTY_DISPATCH !== "1";

describe("subkit REPL over a PTY", () => {
  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "boots to the quick-start banner and exits cleanly",
    async () => {
      const result = await runPtyScenario(
        [quickStartReady(), { kind: "sleep", ms: 1000 }, { kind: "send", text: "\u0004" }],
        {
          persona: env.personas.admin,
          engineUrl: env.baseUrl,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.visible).not.toContain("HTTP 500");
      expect(result.visible).not.toContain("internal_error");
    },
    40_000,
  );

  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "renders the slash-command help pane from the banner",
    async () => {
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/help"),
          { kind: "sleep", ms: 500 },
          { kind: "send", text: "\u0004" },
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(result.exitCode).toBe(0);
      expect(result.visible).toContain("slash commands");
      expect(result.visible).toContain("/help");
    },
    40_000,
  );

  test.skipIf(SKIP_PTY_DISPATCH)(
    "admin renders /mcp catalog pane",
    async () => {
      const logPath = debugFile("mcp-admin");
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/mcp"),
          { kind: "sleep", ms: 2_000 },
          { kind: "send", text: "\u0004" },
        ],
        {
          persona: env.personas.admin,
          engineUrl: env.baseUrl,
          env: { SUBKIT_DEBUG_FILE: logPath },
        },
      );
      expect(result.exitCode).toBe(0);
      const records = readDebug(logPath);
      expect(hasSlashCompletion(records, "mcp")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/resources")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/tools")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/resources")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/tools")).toBe(true);
      expect(result.visible).not.toContain("/mcp requires mcp:read");
      expect(result.visible).not.toContain("HTTP 500");
    },
    45_000,
  );

  test.skipIf(SKIP_PTY_DISPATCH)(
    "member renders /mcp catalog pane",
    async () => {
      const logPath = debugFile("mcp-member");
      const result = await runPtyScenario(
        [
          quickStartReady(),
          { kind: "sleep", ms: 1_000 },
          ...typeLine("/mcp"),
          { kind: "sleep", ms: 2_000 },
          { kind: "send", text: "\u0004" },
        ],
        {
          persona: env.personas.member,
          engineUrl: env.baseUrl,
          env: { SUBKIT_DEBUG_FILE: logPath },
        },
      );
      expect(result.exitCode).toBe(0);
      const records = readDebug(logPath);
      expect(hasSlashCompletion(records, "mcp")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/resources")).toBe(true);
      expect(requestedPath(records, "/v1/mcp/tools")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/prompts")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/resources")).toBe(true);
      expect(succeededPath(records, "/v1/mcp/tools")).toBe(true);
      expect(result.visible).not.toContain("/mcp requires mcp:read");
      expect(result.visible).not.toContain("HTTP 500");
    },
    45_000,
  );
});
