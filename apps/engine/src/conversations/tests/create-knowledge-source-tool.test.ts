import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog, knowledgeSources } from "../../db/schema/index.ts";
import { intakeItems } from "../../db/schema/intake.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createKnowledgeSourceTool } from "../tools/engine-api/writes/create-knowledge-source.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

const CONVERSATION_ID = "00000000-0000-0000-0000-000000000001";

beforeAll(async () => {
  ctx = await createConversationTestCtx("create_ks_tool");
});

afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: CONVERSATION_ID,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: { context: { actor_id: ctx.user_id, actor_type: "user" } } as never,
    getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
    setDraft: async () => {},
  };
}

async function knowledgeSourceCount(): Promise<number> {
  const [row] = await ctx.testDb.db
    .select({ n: count() })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.tenant_id, ctx.tenant_id));
  return Number(row?.n ?? 0);
}

interface Collected {
  collected: boolean;
  admitted: boolean;
  intake_item: { id: string; title: string; category: string; state: string };
  next_action: string;
}

describe("create_knowledge_source tool collects for review", () => {
  test("inline content becomes an inbox item and no knowledge source", async () => {
    const before = await knowledgeSourceCount();
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: "Refund policy",
      content: "# Refund policy\n\nRefunds above 500 EUR need a second approver.",
      description: "Asked for in chat",
    });

    expect(result.ok).toBe(true);
    const data = result.data as Collected;
    expect(data.collected).toBe(true);
    expect(data.admitted).toBe(false);
    expect(data.intake_item.title).toBe("Refund policy");
    expect(data.intake_item.state).toBe("collected");
    expect(data.next_action).toContain("not team knowledge yet");
    expect(await knowledgeSourceCount()).toBe(before);

    const [item] = await ctx.testDb.db
      .select()
      .from(intakeItems)
      .where(
        and(eq(intakeItems.tenant_id, ctx.tenant_id), eq(intakeItems.id, data.intake_item.id)),
      );
    expect(item?.body).toContain("second approver");
    expect(item?.note).toBe("Asked for in chat");
    expect(item?.collected_by_type).toBe("user");
    expect(item?.collected_by_id).toBe(ctx.user_id);
    expect(item?.original_snapshot.origin).toBe("note");

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, item?.id ?? "")));
    expect(audits.map((a) => a.action)).toEqual(["intake_item.collected"]);
  });

  test("repeating the same call returns the same inbox item", async () => {
    const args = { mode: "inline", name: "Shipping rules", content: "Ship on weekdays only." };
    const first = await createKnowledgeSourceTool.execute(toolCtx(), args);
    const second = await createKnowledgeSourceTool.execute(toolCtx(), args);
    expect((second.data as Collected).intake_item.id).toBe(
      (first.data as Collected).intake_item.id,
    );
  });

  test("a secret in the collected text is removed before it is stored", async () => {
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: "Download link",
      content: "Use https://files.example.test/a.pdf?X-Amz-Signature=abc123&x=1 for the export.",
    });
    const [item] = await ctx.testDb.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.id, (result.data as Collected).intake_item.id));
    expect(item?.body).not.toContain("abc123");
    expect(item?.original_snapshot.redactions).toBeGreaterThan(0);
  });

  test("a source address is kept as the origin of the item", async () => {
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: "Vendor limits",
      content: "The vendor allows 100 requests per minute.",
      source_uri: "https://vendor.example.test/limits",
    });
    const [item] = await ctx.testDb.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.id, (result.data as Collected).intake_item.id));
    expect(item?.original_snapshot.source_url).toBe("https://vendor.example.test/limits");
    expect(item?.original_snapshot.origin).toBe("capture");
  });

  test("an attached text file is collected with its file and a title from the filename", async () => {
    const before = await knowledgeSourceCount();
    const attached = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: CONVERSATION_ID,
      filename: "ocpp-reference.md",
      content: "# OCPP\n\nBootNotification registers a charge point.",
      content_type: "text/markdown",
    });

    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "from_attachment",
      file_id: attached.file_id,
      name: "Attachment",
    });

    expect(result.ok).toBe(true);
    const data = result.data as Collected;
    expect(data.intake_item.title).toBe("ocpp-reference");
    const [item] = await ctx.testDb.db
      .select()
      .from(intakeItems)
      .where(eq(intakeItems.id, data.intake_item.id));
    expect(item?.attachment_file_id).not.toBeNull();
    expect(item?.body).toContain("BootNotification");
    expect(await knowledgeSourceCount()).toBe(before);
  });

  test("an unsupported attachment type is refused and nothing is collected", async () => {
    const attached = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: CONVERSATION_ID,
      filename: "archive.zip",
      content: "not really a zip",
      content_type: "application/zip",
    });
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "from_attachment",
      file_id: attached.file_id,
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ error: "unsupported_file_type" });
  });

  test("an unknown file id is refused", async () => {
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "from_attachment",
      file_id: "fid_00000000-0000-4000-8000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ error: "file_not_found" });
  });
});
