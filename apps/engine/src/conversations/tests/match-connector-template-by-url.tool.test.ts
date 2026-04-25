import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { createConversation } from "../service.ts";
import type { ConversationTestCtx } from "../tests/setup.ts";
import { createConversationTestCtx } from "../tests/setup.ts";
import { matchConnectorTemplateByUrlTool } from "../tools/match-connector-template-by-url.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("match_template_by_url");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createToolCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "match-template-by-url",
    },
    ctx.testDb.db,
  );
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: typeof draft) => {
      draft = next;
    },
  };
}

describe("matchConnectorTemplateByUrlTool", () => {
  test("tool name is match_connector_template_by_url", () => {
    expect(matchConnectorTemplateByUrlTool.name).toBe("match_connector_template_by_url");
  });

  test("Stripe URL returns matched=true and slug=stripe", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/customers",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean; matches: Array<{ slug: string }> };
    expect(data.matched).toBe(true);
    expect(data.matches[0]?.slug).toBe("stripe");
  });

  test("invalid URL returns matched=false", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "not-a-url",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matched: boolean };
    expect(data.matched).toBe(false);
  });

  test("limit is respected", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { matches: unknown[] };
    expect(data.matches.length).toBeLessThanOrEqual(1);
  });

  test("result includes setup_instructions and credential_hints", async () => {
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, {
      url: "https://api.stripe.com/v1/charges",
      limit: 1,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      matches: Array<{ setup_instructions: string; credential_hints: unknown[] }>;
    };
    expect(data.matches[0]?.setup_instructions).toBeTruthy();
    expect(Array.isArray(data.matches[0]?.credential_hints)).toBe(true);
  });

  test("url is echoed back in the result", async () => {
    const url = "https://api.stripe.com/v1/invoices";
    const toolCtx = await createToolCtx();
    const result = await matchConnectorTemplateByUrlTool.execute(toolCtx, { url, limit: 3 });
    const data = result.data as { url: string };
    expect(data.url).toBe(url);
  });
});
