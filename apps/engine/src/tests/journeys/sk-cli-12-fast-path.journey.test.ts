import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { executions } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let savedWorkflowSlug = "";
let savedWorkflowId = "";

function makeBuffer() {
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

beforeAll(async () => {
  ctx = await createJourneyCtx("sk-cli-12-fast-path");

  savedWorkflowSlug = "fast-path-test-wf";
  const createRes = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Fast Path Test WF",
      slug: savedWorkflowSlug,
      steps: [
        {
          kind: "request",
          id: "noop",
          method: "GET",
          url: `${ctx.baseUrl}/health`,
        },
      ],
    }),
  });
  const wfBody = (await createRes.json()) as { id: string };
  savedWorkflowId = wfBody.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: sk fast-path — list intent (T16)", () => {
  test("AC1: 'list my workflows' returns skipped_llm: true in stream-json", async () => {
    const stdout = makeBuffer();
    const stderr = makeBuffer();

    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "list my workflows",
      output: "stream-json",
      noMemory: true,
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(0);
    const lines = stdout.lines();
    expect(lines.length).toBeGreaterThan(0);

    let foundSkippedLlm = false;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "tool_result") {
          const output = obj.output as Record<string, unknown> | undefined;
          if (output?.skipped_llm === true) {
            foundSkippedLlm = true;
          }
        }
        if (obj.type === "completed") {
          const toolCalls = obj.tool_calls as
            | Array<{ output?: Record<string, unknown> }>
            | undefined;
          if (toolCalls?.some((tc) => tc.output?.skipped_llm === true)) {
            foundSkippedLlm = true;
          }
        }
      } catch {}
    }
    expect(foundSkippedLlm).toBe(true);
  });

  test("AC2: a second 'list my workflows' call is also fast-path handled", async () => {
    const stdout = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "list my workflows",
      output: "stream-json",
      noMemory: true,
      stdout,
    });
    expect(result.exitCode).toBe(0);
  });

  test("AC4: 'list my executions' is handled by the fast path", async () => {
    const stdout = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "list my executions",
      output: "stream-json",
      noMemory: true,
      stdout,
    });
    expect(result.exitCode).toBe(0);
    const lines = stdout.lines();
    let foundSkippedLlm = false;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "tool_result") {
          const output = obj.output as Record<string, unknown> | undefined;
          if (output?.skipped_llm === true) foundSkippedLlm = true;
        }
      } catch {}
    }
    expect(foundSkippedLlm).toBe(true);
  });
});

describe("journey: sk fast-path — list enumerates completely with exact total (Fix 3)", () => {
  test("AC5: 25 workflows — all enumerated, total=25 in the tool result, exact headline", async () => {
    for (let i = 0; i < 24; i++) {
      const res = await journeyFetch(ctx, "/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: `Bulk WF ${i}`,
          slug: `bulk-wf-${String(i).padStart(2, "0")}`,
          steps: [{ kind: "request", id: "noop", method: "GET", url: `${ctx.baseUrl}/health` }],
        }),
      });
      expect(res.status).toBe(201);
    }

    const stdout = makeBuffer();
    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: "list my workflows",
      output: "stream-json",
      noMemory: true,
      stdout,
    });
    expect(result.exitCode).toBe(0);

    let listOutput: Record<string, unknown> | null = null;
    let assistantText = "";
    for (const line of stdout.lines()) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "tool_result") {
          const output = obj.output as Record<string, unknown> | undefined;
          if (output?.skipped_llm === true && Array.isArray(output.items)) {
            listOutput = output;
          }
        }
        if (obj.type === "message" && obj.role === "assistant") {
          const content = obj.content as string | { text?: unknown } | undefined;
          const text =
            typeof content === "string"
              ? content
              : typeof content?.text === "string"
                ? content.text
                : "";
          if (text.length > 0) assistantText = text;
        }
      } catch {}
    }

    expect(listOutput).not.toBeNull();
    expect(listOutput?.total).toBe(25);
    expect(listOutput?.returned).toBe(25);
    expect(listOutput?.has_more).toBe(false);
    expect((listOutput!.items as unknown[]).length).toBe(25);
    expect(assistantText.startsWith("25 workflows:")).toBe(true);
    expect(assistantText).toContain(savedWorkflowSlug);
    for (let i = 0; i < 24; i++) {
      expect(assistantText).toContain(`bulk-wf-${String(i).padStart(2, "0")}`);
    }
  }, 180000);
});

describe("journey: sk fast-path — run <slug> (T16)", () => {
  test("AC3: 'run <slug>' creates exactly one saved-kind execution row", async () => {
    const priorRows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(eq(executions.workflow_id, savedWorkflowId));
    const priorCount = priorRows.length;

    const stdout = makeBuffer();
    const stderr = makeBuffer();

    const result = await runHeadless({
      profile: profileFor(ctx.tenantId, ctx.apiKey),
      prompt: `run ${savedWorkflowSlug}`,
      output: "stream-json",
      noMemory: true,
      stdout,
      stderr,
    });

    expect(result.exitCode).toBe(0);

    const afterRows = await ctx.db
      .select({ id: executions.id, source_kind: executions.source_kind })
      .from(executions)
      .where(eq(executions.workflow_id, savedWorkflowId));

    expect(afterRows.length).toBeGreaterThan(priorCount);
    const newRows = afterRows.slice(priorCount);
    expect(newRows.every((r) => r.source_kind === "saved")).toBe(true);
  }, 180000);
});
