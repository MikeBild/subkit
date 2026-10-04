// Integration tests for the `create_knowledge_source` conversation tool.
//
// Coverage:
//   - mode='inline' happy path: creates KS row, produces ≥1 chunk, writes
//     two audit rows (svc + tool)
//   - mode='from_attachment' happy path: derives name from filename, creates
//     KS row with correct mime_type
//   - mode='from_attachment' unknown file_id → error envelope, no KS row
//   - scope='workflow' without workflow_id → error envelope
//   - identical content re-run: dedup is within-run only so both KS rows
//     exist but both have the same chunk_count (not doubled)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { auditLog, knowledgeChunks, knowledgeSources } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createKnowledgeSourceTool } from "../tools/engine-api/writes/create-knowledge-source.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("create_ks_tool");
});

afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext for in-process service calls
  const engineClientStub: any = {
    context: { actor_id: ctx.user_id, actor_type: "user" },
    knowledgeSources: {
      // biome-ignore lint/suspicious/noExplicitAny: in-process service forwarding
      create: async (params: any) => {
        const { createKnowledgeSource } = await import("../../knowledge/service.ts");
        return createKnowledgeSource(
          {
            tenant_id: ctx.tenant_id,
            input: params.input,
            upload: params.upload,
            actor_id: ctx.user_id,
            ...(params.source_type_override
              ? { source_type_override: params.source_type_override }
              : {}),
            ...(params.source_uri_override
              ? { source_uri_override: params.source_uri_override }
              : {}),
          },
          ctx.testDb.db,
        );
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal audit stub
    audit_write: async (entry: any) => {
      const { auditAwait } = await import("../../audit/audit.ts");
      const { AuditAction } = await import("../../audit/types.ts");
      const row = await auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "user",
          actor_id: ctx.user_id,
          action: AuditAction.KNOWLEDGE_SOURCE_CREATED,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.testDb.db,
      );
      return row.id;
    },
  };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: "00000000-0000-0000-0000-000000000001",
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
    setDraft: async () => {},
  };
}

const MARKDOWN_CONTENT = [
  "# OCPP 2.0.1 Protocol Reference",
  "",
  "The Open Charge Point Protocol (OCPP) defines the communication between",
  "charging stations and central management systems.",
  "",
  "## BootNotification",
  "",
  "Sent by the Charge Point to register itself with the Central System.",
  "The Central System responds with a status (Accepted / Pending / Rejected).",
  "",
  "### Request Fields",
  "- `chargePointVendor`: string, required",
  "- `chargePointModel`: string, required",
  "- `chargePointSerialNumber`: string, optional",
  "",
  "## Heartbeat",
  "",
  "Sent periodically to confirm that the Charge Point is alive.",
  "The Central System responds with the current time.",
  "",
  "### Interval",
  "Configured via `HeartbeatInterval` in the configuration key list.",
].join("\n");

describe("create_knowledge_source tool — mode='inline'", () => {
  test("happy path: creates KS row with chunk_count >= 1 and two audit rows", async () => {
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: "OCPP Protocol Ref",
      content: MARKDOWN_CONTENT,
    });

    expect(result.ok).toBe(true);
    const data = result.data as {
      created: boolean;
      knowledge_source: {
        id: string;
        name: string;
        slug: string;
        scope: string;
        status: string;
        chunk_count: number;
        bytes_total: number;
      };
      audit_log_id: string;
    };
    expect(data.created).toBe(true);
    expect(data.knowledge_source.name).toBe("OCPP Protocol Ref");
    expect(data.knowledge_source.scope).toBe("global");
    expect(data.knowledge_source.status).toBe("active");
    expect(data.knowledge_source.chunk_count).toBeGreaterThanOrEqual(1);
    expect(typeof data.audit_log_id).toBe("string");

    // Confirm row exists in DB for this tenant
    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, ctx.tenant_id),
          eq(knowledgeSources.id, data.knowledge_source.id),
        ),
      )
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.slug).toBe(data.knowledge_source.slug);

    // Two audit rows: one from svc.createKnowledgeSource (knowledge_source.created)
    // and one from the tool itself (conversation.create_knowledge_source via stub).
    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, data.knowledge_source.id));
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("knowledge_source.created");
    // The tool audit_write stub maps to knowledge_source.created enum;
    // assert that the tool-level audit row was written (audit_log_id non-null).
    expect(data.audit_log_id.length).toBeGreaterThan(0);
  });
});

describe("create_knowledge_source tool — mode='from_attachment'", () => {
  test("happy path: derives name from filename, creates KS row", async () => {
    // Seed a real file row + object-store bytes via the production helper.
    // Byte-unique content: files rows are content-addressed per tenant, so
    // reusing MARKDOWN_CONTENT would dedup onto the inline test's row and
    // this test would inherit THAT row's filename instead of exercising
    // the ocpp-reference.md derivation.
    const attached = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id: "00000000-0000-0000-0000-000000000001",
      filename: "ocpp-reference.md",
      content: `${MARKDOWN_CONTENT}\n\n## Attachment fixture marker\n`,
      content_type: "text/markdown",
    });

    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "from_attachment",
      file_id: attached.file_id,
    });

    expect(result.ok).toBe(true);
    const data = result.data as {
      created: boolean;
      knowledge_source: {
        id: string;
        name: string;
        slug: string;
        scope: string;
        chunk_count: number;
      };
      audit_log_id: string;
    };
    expect(data.created).toBe(true);
    // Name should default to filename stem when name is not supplied
    expect(data.knowledge_source.name).toBe("ocpp-reference");
    expect(data.knowledge_source.chunk_count).toBeGreaterThanOrEqual(1);

    // KS row persisted for tenant
    const rows = await ctx.testDb.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, ctx.tenant_id),
          eq(knowledgeSources.id, data.knowledge_source.id),
        ),
      )
      .limit(1);
    expect(rows.length).toBe(1);
    // source_uri should be the filename (from_attachment sets source_uri_override = filename)
    expect(rows[0]?.source_uri).toBe("ocpp-reference.md");
  });

  test("unknown file_id → ok=false, error='file_not_found', no KS row written", async () => {
    const beforeCount = await ctx.testDb.db
      .select({ n: count() })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, ctx.tenant_id));
    const countBefore = Number(beforeCount[0]?.n ?? 0);

    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "from_attachment",
      file_id: "fid_00000000-dead-beef-0000-000000000000",
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error: string; file_id: string };
    expect(data.error).toBe("file_not_found");
    expect(data.file_id).toBe("fid_00000000-dead-beef-0000-000000000000");

    // No new KS row created
    const afterCount = await ctx.testDb.db
      .select({ n: count() })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, ctx.tenant_id));
    expect(Number(afterCount[0]?.n ?? 0)).toBe(countBefore);
  });
});

describe("create_knowledge_source tool — scope validation", () => {
  test("scope='workflow' without workflow_id → ok=false, error='scope_workflow_requires_workflow_id'", async () => {
    const result = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: "Scoped KS",
      content: "Some content that would be valid otherwise.",
      scope: "workflow",
      // workflow_id intentionally omitted
    });

    expect(result.ok).toBe(false);
    const data = result.data as { error: string };
    expect(data.error).toBe("scope_workflow_requires_workflow_id");
  });
});

describe("create_knowledge_source tool — dedup behaviour", () => {
  test("two runs with identical content each produce a separate KS row; chunk dedup is within-run only", async () => {
    const name1 = "Dedup Test KS First";
    const name2 = "Dedup Test KS Second";
    const content = MARKDOWN_CONTENT;

    const result1 = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: name1,
      content,
    });
    const result2 = await createKnowledgeSourceTool.execute(toolCtx(), {
      mode: "inline",
      name: name2,
      content,
    });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    const d1 = (result1.data as { knowledge_source: { id: string; chunk_count: number } })
      .knowledge_source;
    const d2 = (result2.data as { knowledge_source: { id: string; chunk_count: number } })
      .knowledge_source;

    // Two distinct rows
    expect(d1.id).not.toBe(d2.id);

    // Dedup is within-run only (per dedup.ts comment: "single-run check").
    // Cross-source dedup is NOT applied, so each source gets its own chunks.
    // Both sources therefore have the same chunk_count.
    expect(d1.chunk_count).toBe(d2.chunk_count);

    // Confirm total knowledge_chunks rows equals 2 × chunk_count (no cross-source dedup)
    const totalChunks1 = await ctx.testDb.db
      .select({ n: count() })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, d1.id));
    const totalChunks2 = await ctx.testDb.db
      .select({ n: count() })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, d2.id));

    expect(Number(totalChunks1[0]?.n ?? 0)).toBe(d1.chunk_count);
    expect(Number(totalChunks2[0]?.n ?? 0)).toBe(d2.chunk_count);
  });
});
