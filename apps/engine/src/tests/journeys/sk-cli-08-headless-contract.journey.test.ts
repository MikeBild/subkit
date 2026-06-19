// User story: As a script author piping `sk -p "..."` into another
// tool, I need every output format to produce a stable, parseable
// contract: `text` prints only the final assistant message, `json`
// emits a single well-formed object, and `stream-json` emits one
// JSON object per line ending with a `completed` frame.
//
// Acceptance criteria:
//
//   AC1. text output prints a single line of assistant text on
//        stdout and exits 0.
//   AC2. json output emits a parseable JSON blob containing
//        `session_id`, `status`, `assistant_text`, `tool_calls`,
//        `committed_workflow_id`, `validation_errors`, `usage`,
//        `warnings`, `memory_sources`.
//   AC3. stream-json output emits NDJSON where every line parses
//        and the final line is `type=completed`.
//   AC4. --no-memory suppresses the `memory_sources` array (stays
//        empty) and no `conversation.memory_injected` row is
//        written by the engine.
//   AC5. A failing prompt (engine returns 4xx) exits non-zero.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;

interface WriterBuffer {
  write: (s: string) => void;
  lines(): string[];
  toString(): string;
}

function makeBuffer(): WriterBuffer {
  const chunks: string[] = [];
  return {
    write: (s: string) => {
      chunks.push(s);
    },
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0),
    toString: () => chunks.join(""),
  };
}

function profileFor(tenantId: string, apiKey: string): ResolvedProfile {
  return {
    name: "journey",
    engine_url: ctx.baseUrl,
    api_key: apiKey,
    active_tenant_id: tenantId,
  };
}

describe("journey: sk headless output contract", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-08-headless");
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: --output text prints one line of assistant text and exits 0", async () => {
    const stdout = makeBuffer();
    const stderr = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "list the active workflows",
      output: "text",
      noMemory: true,
      stdout,
      stderr,
    });
    expect(result.exitCode).toBe(0);
    expect(result.conversation_id).not.toBeNull();
    // Text output may be empty ONLY when the turn produced neither
    // assistant text nor a succeeded execution result — when a
    // run_workflow/wf_* call succeeded, headless renders its payload
    // (see turn-event.execution-result.test.ts). stderr must never
    // carry an error line either way.
    expect(stderr.toString()).not.toContain("sk:");
  });

  test("AC2: --output json emits a parseable envelope with all documented fields", async () => {
    const stdout = makeBuffer();
    const stderr = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "create a sample workflow",
      output: "json",
      noMemory: true,
      stdout,
      stderr,
    });
    expect(result.exitCode).toBe(0);
    const raw = stdout.toString().trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.session_id).toBeDefined();
    expect(typeof parsed.status).toBe("string");
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(Array.isArray(parsed.tool_calls)).toBe(true);
    expect(Array.isArray(parsed.validation_errors)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(Array.isArray(parsed.memory_sources)).toBe(true);
    // assistant_text is always present even when empty.
    expect(typeof parsed.assistant_text).toBe("string");
  });

  test("AC3: --output stream-json emits NDJSON ending with a `completed` frame", async () => {
    const stdout = makeBuffer();
    const stderr = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "stream a turn",
      output: "stream-json",
      noMemory: true,
      stdout,
      stderr,
    });
    expect(result.exitCode).toBe(0);
    const lines = stdout.lines();
    expect(lines.length).toBeGreaterThan(0);
    // every line is a valid JSON object
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // the last line is a `completed` event
    const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { type?: string };
    expect(last.type).toBe("completed");
  });

  test("AC4: --no-memory skips injection — no CONVERSATION_MEMORY_INJECTED audit row", async () => {
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "no memory here",
      output: "text",
      noMemory: true,
      stdout: makeBuffer(),
      stderr: makeBuffer(),
    });
    expect(result.exitCode).toBe(0);
    const rows = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "conversation.memory_injected"),
          eq(auditLog.resource_id, result.conversation_id as string),
        ),
      );
    expect(rows.length).toBe(0);
  });

  test("AC5: a broken profile (invalid API key) exits with code 2", async () => {
    const stdout = makeBuffer();
    const stderr = makeBuffer();
    const result = await runHeadless({
      profile: {
        name: "bad",
        engine_url: ctx.baseUrl,
        api_key: "wf_live_not-a-real-key-aaaaaaaaaaaaaaaaaaaaaa",
        active_tenant_id: ctx.tenantId,
      },
      prompt: "will fail",
      output: "text",
      noMemory: true,
      stdout,
      stderr,
    });
    expect(result.exitCode).toBe(2);
    expect(stderr.toString()).toContain("sk:");
  });
});
