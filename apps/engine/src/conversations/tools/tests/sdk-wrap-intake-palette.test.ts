import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { DraftDocument, TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { INTAKE_ITEM_DEPENDENT_TOOLS } from "../sdk-wrap/intake-review-guard.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("sdk-wrap-intake-palette");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function signals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

function toolContext(draft: DraftDocument): ToolContext {
  const db = ctx.testDb.db as unknown as Db;
  return {
    db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db,
    }),
    getDraft: () => draft,
    setDraft: async () => {},
  };
}

async function palette(draft: DraftDocument): Promise<Set<string>> {
  const events: TurnEvent[] = [];
  const wrapped = await wrapTools(
    toolContext(draft),
    signals(),
    events,
    ctx.testDb.db as unknown as Db,
    [],
    {},
  );
  return new Set(Object.keys(wrapped));
}

const emptyDraft: DraftDocument = { workflow: { name: "", steps: [] } };

describe("intake tools follow the item they depend on", () => {
  it("hides tools that need a read intake item until a review is active", async () => {
    const names = await palette(emptyDraft);
    for (const tool of INTAKE_ITEM_DEPENDENT_TOOLS) expect(names.has(tool)).toBe(false);
    expect(names.has("get_intake_item")).toBe(true);
    expect(names.has("list_intake_items")).toBe(true);
    expect(names.has("set_default_intake_category")).toBe(true);
  });

  it("shows them once an item was read in this conversation", async () => {
    const names = await palette({
      ...emptyDraft,
      session: { intake_review_active: true },
    });
    for (const tool of INTAKE_ITEM_DEPENDENT_TOOLS) expect(names.has(tool)).toBe(true);
  });

  it("shows them in a conversation opened from selected items", async () => {
    const names = await palette({
      ...emptyDraft,
      session: { intake_item_ids: ["00000000-0000-4000-8000-000000000001"] },
    });
    for (const tool of INTAKE_ITEM_DEPENDENT_TOOLS) expect(names.has(tool)).toBe(true);
  });

  it("only lists tools that are real intake tools", () => {
    expect([...INTAKE_ITEM_DEPENDENT_TOOLS].sort()).toEqual([
      "create_intake_proposal",
      "discard_intake_items",
      "move_intake_item",
      "restore_intake_item",
      "revise_intake_proposal",
    ]);
  });
});
