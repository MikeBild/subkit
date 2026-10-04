import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { dryRunStepTool } from "../tools/dry-run-step.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x4e1d_3a7);

let ctx: ConversationTestCtx;
let mock: MockServer;

const hits: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-step-hold");
  mock = await createMockServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    return jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

function hitsFor(path: string): Array<{ method: string; url: string }> {
  return hits.filter((h) => h.url.startsWith(path));
}

function makeCtx(initial: DraftDocument): ToolContext {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
}

function writeStepDraft(): DraftDocument {
  return {
    workflow: {
      name: "hold-step",
      slug: "hold-step",
      steps: [
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { subject: "Welcome" },
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

interface HeldEnvelope {
  held?: boolean;
  held_request?: { method?: string; url?: string; body?: unknown };
  step_traces?: Array<{ step_id: string; held?: boolean }>;
}

describe("dry_run_step · hold-writes", () => {
  test("whole draft preview holds writes", async () => {
    hits.length = 0;
    const result = await dryRunWorkflowTool.execute(makeCtx(writeStepDraft()), {});
    expect(hitsFor("/send")).toHaveLength(0);
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenant_id));
    const run = rows.find((row) => row.source_kind === "draft");
    expect(run).toBeDefined();
    expect(run?.hold_writes).toBe(true);
    expect(JSON.stringify(result.data)).toContain("held");
  });

  test("write-classified step is HELD by default — zero egress, result carries the held marker", async () => {
    hits.length = 0;
    const result = await dryRunStepTool.execute(makeCtx(writeStepDraft()), {
      step_id: "send",
    });

    expect(result.ok).toBe(true);
    expect(hitsFor("/send")).toHaveLength(0);

    const data = result.data as HeldEnvelope;
    expect(data.held).toBe(true);
    expect(data.held_request?.method).toBe("POST");
    expect(data.held_request?.url).toBe(`${mock.baseUrl}/send`);
    expect(data.held_request?.body).toEqual({ subject: "Welcome" });
  });
});
