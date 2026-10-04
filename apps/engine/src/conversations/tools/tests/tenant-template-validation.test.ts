import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectorTemplates } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { ConnectorDraftDocument, DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";

let ctx: ConversationTestCtx;

const TENANT_TEMPLATE_SLUG = "acme-internal-api";

beforeAll(async () => {
  ctx = await createConversationTestCtx("tenant_template_validation");
  await ctx.testDb.db.insert(connectorTemplates).values({
    tenant_id: ctx.tenant_id,
    slug: TENANT_TEMPLATE_SLUG,
    name: "Acme Internal API",
    driver: "http",
    base_url: "https://api.acme-internal.test/v1",
    auth_type: "bearer",
    ingestion_source: "openapi",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

function draftWithConnector(connector: ConnectorDraftDocument): DraftDocument {
  return { ...createEmptyDraftDocument(), connector };
}

async function createToolCtx(initial: DraftDocument): Promise<ToolContext> {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "tenant-template-validation-test",
    },
    ctx.testDb.db,
  );
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
}

describe("tenant-template visibility in draft validation", () => {
  test("inspect_connector_draft accepts a draft bound to a tenant template", async () => {
    const toolCtx = await createToolCtx(
      draftWithConnector({
        name: "Acme Internal",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://api.acme-internal.test/v1",
        template_slug: TENANT_TEMPLATE_SLUG,
      } as ConnectorDraftDocument),
    );
    const result = await inspectConnectorDraftTool.execute(toolCtx, {});
    expect(result.ok).toBe(true);
    const validation = (result.data as { validation: { ok: boolean; errors: unknown[] } })
      .validation;
    expect(
      (validation.errors as Array<{ path: string }>).some((e) => e.path === "template_slug"),
    ).toBe(false);
    expect(validation.ok).toBe(true);
  });

  test("a genuinely unknown template slug is still rejected", async () => {
    const toolCtx = await createToolCtx(
      draftWithConnector({
        name: "Ghost",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: "https://api.acme-internal.test/v1",
        template_slug: "does-not-exist-anywhere",
      } as ConnectorDraftDocument),
    );
    const result = await inspectConnectorDraftTool.execute(toolCtx, {});
    const validation = (result.data as { validation: { ok: boolean; errors: unknown[] } })
      .validation;
    expect(
      (validation.errors as Array<{ path: string; message: string }>).some(
        (e) => e.path === "template_slug",
      ),
    ).toBe(true);
  });
});
