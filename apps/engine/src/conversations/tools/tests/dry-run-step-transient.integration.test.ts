import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EngineClient } from "../../../engine-client/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../../execution/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument, withWorkflowDraft } from "../../authoring-state/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { dryRunStepTool } from "../dry-run-step.ts";
import type { ToolContext } from "../index.ts";

const skip = process.env.REQUIRES_PG === "0";
const nextUuid = createDeterministicUuidFactory(0xd47);

let convCtx: ConversationTestCtx;
let mock: MockServer;
let requestCount = 0;
let mockHandler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  if (skip) return;
  convCtx = await createConversationTestCtx("drs-transient");
  mock = await createMockServer((req, res) => {
    requestCount += 1;
    mockHandler(req, res);
  });
}, 120_000);

afterAll(async () => {
  if (skip) return;
  await mock?.close();
  await convCtx?.cleanup();
}, 30_000);

function makeCtxWithStep(stepUrl: string): ToolContext {
  const draft = withWorkflowDraft(createEmptyDraftDocument("workflow_authoring"), {
    name: "transient-retry-test",
    steps: [
      {
        id: "fetch",
        kind: "request",
        method: "GET",
        url: stepUrl,
        max_retries: 0,
      },
    ],
  });
  let liveDraft = draft;
  return {
    db: convCtx.testDb.db,
    tenant_id: convCtx.tenant_id,
    conversation_id: nextUuid(),
    actor_id: convCtx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: convCtx.tenant_id,
      actor_id: convCtx.user_id,
      actor_type: "user",
      db: convCtx.testDb.db,
    }),
    getDraft: () => liveDraft,
    // biome-ignore lint/suspicious/noExplicitAny: cast mirrors the as unknown as ToolContext above
    setDraft: async (next: any) => {
      liveDraft = next;
    },
    onLog: () => {},
  } as unknown as ToolContext;
}

describe.skipIf(skip)("dry_run_step — transient-retry absorbs flaky upstreams", () => {
  test("fails http_5xx twice then succeeds → ok:true, server called 3 times", async () => {
    // allow-wall-clock: dry_run_step sleeps 500ms + 1000ms between retries.
    requestCount = 0;
    mockHandler = (_, res) => {
      if (requestCount < 3) {
        jsonResponse(res, 503, { error: "Service temporarily unavailable" });
        return;
      }
      jsonResponse(res, 200, { items: [{ id: "r1" }] });
    };

    const ctx = makeCtxWithStep(`${mock.baseUrl}/data`);
    const result = await dryRunStepTool.execute(ctx, { step_id: "fetch" });

    expect(result.ok).toBe(true);
    expect(requestCount).toBe(3);
  }, 60_000);

  test("deterministic 4xx is NOT retried → ok:false on first attempt", async () => {
    requestCount = 0;
    mockHandler = (_, res) => {
      jsonResponse(res, 404, { error: "Not Found" });
    };

    const ctx = makeCtxWithStep(`${mock.baseUrl}/data`);
    const result = await dryRunStepTool.execute(ctx, { step_id: "fetch" });

    expect(result.ok).toBe(false);
    expect(requestCount).toBe(1);
  }, 10_000);
});
