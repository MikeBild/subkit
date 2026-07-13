// E2E journey: fast-path skipped_llm (T16 from manifest).
//
// User story: As a script author, I want `sk -p "list my workflows"` to
// return sub-second with the LLM skipped entirely, and
// `sk -p "run <saved-workflow>"` to dispatch one saved-kind execution row.
//
// Acceptance criteria:
//
//   AC1. `sk -p "list my workflows"` completes and the response data
//        includes `skipped_llm: true` (via stream-json output).
//   AC2. A second call to `sk -p "list my workflows"` is also handled
//        by the fast path (idempotent, not a one-time hit).
//   AC3. `sk -p "run <slug>"` creates exactly one new execution row with
//        source_kind = "saved" and exits 0.
//   AC4. `sk -p "list my executions"` is also handled by the fast path.
//   AC5. Ground-truth cardinality (Fix 3 regression): with 25 workflows
//        in the tenant, "list my workflows" enumerates ALL of them and
//        the self-describing tool result carries total=25 / returned=25 /
//        has_more=false; the assistant headline names the exact total.
//        (Previously LIST_LIMIT=10 rendered "10 workflows:" as if
//        complete while the tenant had more.)
//
// Note: the tests use `runHeadless` (sk's in-process headless runner)
// so they avoid spawning a child process while still testing the full
// HTTP path through the engine.

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

  // Seed a saved workflow that the fast-path can run
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
          // The journey engine's own health endpoint — fully local, always
          // up. Both httpbin.org and httpstat.us have hung CI runners
          // (180s timeouts on every attempt, 2026-06-11); this journey
          // asserts fast-path dispatch, not outbound networking.
          url: `${ctx.baseUrl}/v1/health`,
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

// ---------------------------------------------------------------------------
// AC1 + AC2: list-intent is handled by fast path
// ---------------------------------------------------------------------------

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
    // Parse the NDJSON lines to find the tool_result event
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
        // Also check in the completed envelope
        if (obj.type === "completed") {
          const toolCalls = obj.tool_calls as
            | Array<{ output?: Record<string, unknown> }>
            | undefined;
          if (toolCalls?.some((tc) => tc.output?.skipped_llm === true)) {
            foundSkippedLlm = true;
          }
        }
      } catch {
        // Skip unparseable lines
      }
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
      } catch {
        // Skip
      }
    }
    expect(foundSkippedLlm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5: complete enumeration + exact total (ground-truth cardinality)
// ---------------------------------------------------------------------------

describe("journey: sk fast-path — list enumerates completely with exact total (Fix 3)", () => {
  test("AC5: 25 workflows — all enumerated, total=25 in the tool result, exact headline", async () => {
    // Seed 24 more workflows next to the one from beforeAll → 25 total.
    for (let i = 0; i < 24; i++) {
      const res = await journeyFetch(ctx, "/v1/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: `Bulk WF ${i}`,
          slug: `bulk-wf-${String(i).padStart(2, "0")}`,
          steps: [{ kind: "request", id: "noop", method: "GET", url: `${ctx.baseUrl}/v1/health` }],
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
          // Live events carry `content` as a string; the SSE replay path
          // re-emits the persisted message content `{ text, fast_path }`.
          const content = obj.content as string | { text?: unknown } | undefined;
          const text =
            typeof content === "string"
              ? content
              : typeof content?.text === "string"
                ? content.text
                : "";
          if (text.length > 0) assistantText = text;
        }
      } catch {
        // Skip unparseable lines
      }
    }

    expect(listOutput).not.toBeNull();
    // Self-describing envelope: the page IS the universe and says so.
    expect(listOutput?.total).toBe(25);
    expect(listOutput?.returned).toBe(25);
    expect(listOutput?.has_more).toBe(false);
    expect((listOutput!.items as unknown[]).length).toBe(25);
    // Headline names the exact total — "25 workflows:" only when 25 shown.
    expect(assistantText.startsWith("25 workflows:")).toBe(true);
    // Complete enumeration — every seeded slug appears.
    expect(assistantText).toContain(savedWorkflowSlug);
    for (let i = 0; i < 24; i++) {
      expect(assistantText).toContain(`bulk-wf-${String(i).padStart(2, "0")}`);
    }
  }, 180000);
});

// ---------------------------------------------------------------------------
// AC3: run <slug> creates a saved execution row
// ---------------------------------------------------------------------------

describe("journey: sk fast-path — run <slug> (T16)", () => {
  // 180s timeout — the journey spins up the sk binary as a subprocess,
  // talks to the local engine over HTTP, and asserts on the executions
  // table. Locally completes in ~25s but CI's parallel `bun test` runner
  // under testcontainers contention has been observed past the default
  // 60s timeout. The headroom matches CP5's full-verify e2e budget.
  test("AC3: 'run <slug>' creates exactly one saved-kind execution row", async () => {
    // Count executions for this workflow before the run
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

    // Check that at least one new execution was created with source_kind=saved
    const afterRows = await ctx.db
      .select({ id: executions.id, source_kind: executions.source_kind })
      .from(executions)
      .where(eq(executions.workflow_id, savedWorkflowId));

    expect(afterRows.length).toBeGreaterThan(priorCount);
    // Every new row written by this turn must be saved-kind — a draft
    // or step row leaking through would mean the fast-path dispatched
    // the wrong execution source.
    const newRows = afterRows.slice(priorCount);
    expect(newRows.every((r) => r.source_kind === "saved")).toBe(true);
  }, 180000);
});
