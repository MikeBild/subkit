import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createKnowledgeSourceTool } from "../../conversations/tools/engine-api/writes/create-knowledge-source.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { knowledgeSources } from "../../db/schema/index.ts";
import { intakeItems } from "../../db/schema/intake.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { invalidateKnowledgeCache, searchKnowledge } from "../../knowledge/service.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const CONVERSATION_ID = "00000000-0000-0000-0000-000000000099";

const OCPP_FIXTURE = [
  "# OCPP 2.0.1 Protocol Reference",
  "",
  "The Open Charge Point Protocol defines communication between charging stations",
  "and central management systems (CSMS). This document covers the core messages.",
  "",
  "## BootNotification",
  "",
  "Sent by the Charge Point to register itself with the CSMS after every reboot.",
].join("\n");

function makeToolCtx(ctx: JourneyCtx): ToolContext {
  return {
    db: ctx.db,
    tenant_id: ctx.tenantId,
    conversation_id: CONVERSATION_ID,
    actor_id: ctx.userId,
    connector_id: null,
    workflow_id: null,
    engineClient: { context: { actor_id: ctx.userId, actor_type: "user" } } as never,
    getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
    setDraft: async () => {},
  };
}

let ctxA: JourneyCtx;
let ctxB: JourneyCtx;

beforeAll(async () => {
  ctxA = await createJourneyCtx("ks-ingest-53-a");
  ctxB = await createJourneyCtx("ks-ingest-53-b");

  invalidateKnowledgeCache(ctxA.tenantId);
  invalidateKnowledgeCache(ctxB.tenantId);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctxA?.cleanup) await ctxA.cleanup();
  if (ctxB?.cleanup) await ctxB.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("create_knowledge_source tool — collect for review", () => {
  test("AC1: an attachment lands in the inbox and is not searchable before a person admits it", async () => {
    const attached = await attachInlineForTest({
      db: ctxA.db,
      tenant_id: ctxA.tenantId,
      conversation_id: CONVERSATION_ID,
      filename: "ocpp-reference.md",
      content: OCPP_FIXTURE,
      content_type: "text/markdown",
    });

    const result = await createKnowledgeSourceTool.execute(makeToolCtx(ctxA), {
      mode: "from_attachment",
      file_id: attached.file_id,
      name: "OCPP 2.0.1 Reference",
    });

    expect(result.ok).toBe(true);
    const data = result.data as {
      collected: boolean;
      admitted: boolean;
      intake_item: { id: string; title: string; state: string };
    };
    expect(data.collected).toBe(true);
    expect(data.admitted).toBe(false);
    expect(data.intake_item.title).toBe("OCPP 2.0.1 Reference");

    const listRes = await journeyFetch(ctxA, "/v1/knowledge-sources");
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { items: Array<{ name: string }> };
    expect(listed.items.some((source) => source.name === "OCPP 2.0.1 Reference")).toBe(false);

    invalidateKnowledgeCache(ctxA.tenantId);
    const hits = await searchKnowledge(
      { tenant_id: ctxA.tenantId, query: "BootNotification" },
      ctxA.db,
    );
    expect(hits).toEqual([]);

    const items = await ctxA.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctxA.tenantId));
    expect(items.map((item) => item.id)).toContain(data.intake_item.id);
  });

  test("AC2: file_id from tenant B is rejected with file_not_found when used from tenant A", async () => {
    const attachedB = await attachInlineForTest({
      db: ctxB.db,
      tenant_id: ctxB.tenantId,
      conversation_id: CONVERSATION_ID,
      filename: "tenant-b-doc.md",
      content: "This document belongs to tenant B.",
      content_type: "text/markdown",
    });

    const result = await createKnowledgeSourceTool.execute(makeToolCtx(ctxA), {
      mode: "from_attachment",
      file_id: attachedB.file_id,
    });

    expect(result.ok).toBe(false);
    const errData = result.data as { error: string; file_id: string };
    expect(errData.error).toBe("file_not_found");
    expect(errData.file_id).toBe(attachedB.file_id);

    const rows = await ctxA.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, ctxA.tenantId));
    expect(rows.some((r) => r.source_uri === "tenant-b-doc.md")).toBe(false);
    const items = await ctxA.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctxA.tenantId));
    expect(items.some((item) => item.title === "tenant-b-doc")).toBe(false);
  });
});
