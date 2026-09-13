// Journey 53: create_knowledge_source tool creates a searchable KS, and
// cross-tenant file isolation is enforced.
//
// Acceptance criteria:
//   - AC1: invoking `create_knowledge_source` with mode='from_attachment'
//          in-process (direct tool call with synthesised ToolContext)
//          produces ok=true, chunk_count >= 2, the KS row appears in
//          GET /v1/knowledge-sources, and searchKnowledge("BootNotification")
//          returns at least one hit whose knowledge_source_id matches.
//   - AC2: supplying a file_id that belongs to tenant B while operating
//          as tenant A returns ok=false, error='file_not_found'. No KS row
//          is written. This proves requireFileForTenant isolation.
//
// Spec refs: docs/authors/authoring-workflows.md, docs/concepts/glossary.md (Knowledge Sources)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { createKnowledgeSourceTool } from "../../conversations/tools/generated/writes/create-knowledge-source.ts";
import type { ToolContext } from "../../conversations/tools/index.ts";
import { knowledgeSources } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { invalidateKnowledgeCache, searchKnowledge } from "../../knowledge/service.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

// ---------- OCPP fixture (produces ≥2 chunks when parsed as Markdown) ----------

const OCPP_FIXTURE = [
  "# OCPP 2.0.1 Protocol Reference",
  "",
  "The Open Charge Point Protocol defines communication between charging stations",
  "and central management systems (CSMS). This document covers the core messages.",
  "",
  "## BootNotification",
  "",
  "Sent by the Charge Point to register itself with the CSMS after every reboot.",
  "The CSMS responds with Accepted, Pending, or Rejected and a current timestamp.",
  "",
  "### Request Fields",
  "- `chargePointVendor`: string — manufacturer name, required.",
  "- `chargePointModel`: string — model identifier, required.",
  "- `chargePointSerialNumber`: string — optional serial.",
  "- `firmwareVersion`: string — optional firmware tag.",
  "",
  "### Response Fields",
  "- `currentTime`: dateTime — CSMS wall clock, required.",
  "- `heartbeatInterval`: integer — seconds between Heartbeats, required.",
  "- `status`: enum — Accepted | Pending | Rejected, required.",
  "",
  "## Heartbeat",
  "",
  "Sent periodically by the Charge Point to confirm it is still online.",
  "No request fields. Response carries `currentTime` only.",
  "",
  "## StatusNotification",
  "",
  "Reports connector status changes (Available, Preparing, Charging, etc.).",
  "Required fields: `connectorId`, `errorCode`, `status`.",
  "",
  "## RemoteStartTransaction",
  "",
  "Allows the CSMS to initiate a charging session on a specific connector.",
  "Required: `idTag`. Optional: `connectorId`, `chargingProfile`.",
  "",
  "## RemoteStopTransaction",
  "",
  "Stops a running transaction by `transactionId`.",
].join("\n");

// ---------- helpers ----------

function makeToolCtx(ctx: JourneyCtx): ToolContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub for in-process service forwarding
  const engineClientStub: any = {
    context: { actor_id: ctx.userId, actor_type: "user" },
    knowledgeSources: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- in-process service forwarding
      create: async (params: any) => {
        const { createKnowledgeSource } = await import("../../knowledge/service.ts");
        return createKnowledgeSource(
          {
            tenant_id: ctx.tenantId,
            input: params.input,
            upload: params.upload,
            actor_id: ctx.userId,
            ...(params.source_type_override
              ? { source_type_override: params.source_type_override }
              : {}),
            ...(params.source_uri_override
              ? { source_uri_override: params.source_uri_override }
              : {}),
          },
          ctx.db,
        );
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal audit stub
    audit_write: async (entry: any) => {
      const row = await auditAwait(
        {
          tenant_id: ctx.tenantId,
          actor_type: "user",
          actor_id: ctx.userId,
          action: AuditAction.KNOWLEDGE_SOURCE_CREATED,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.db,
      );
      return row.id;
    },
  };
  return {
    db: ctx.db,
    tenant_id: ctx.tenantId,
    conversation_id: "00000000-0000-0000-0000-000000000099",
    actor_id: ctx.userId,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
    setDraft: async () => {},
  };
}

// ---------- setup ----------

let ctxA: JourneyCtx;
let ctxB: JourneyCtx;

beforeAll(async () => {
  ctxA = await createJourneyCtx("ks-ingest-53-a");
  ctxB = await createJourneyCtx("ks-ingest-53-b");

  // Start both journeys from a clean knowledge-search cache.
  invalidateKnowledgeCache(ctxA.tenantId);
  invalidateKnowledgeCache(ctxB.tenantId);
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctxA?.cleanup) await ctxA.cleanup();
  if (ctxB?.cleanup) await ctxB.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 53: create_knowledge_source tool — ingest and search", () => {
  // ----------------------------------------------------------------
  // AC1: tool invocation creates a searchable KS
  // ----------------------------------------------------------------

  test("AC1: mode='from_attachment' creates a KS with chunk_count >= 2 and search returns hits", async () => {
    // 1. Seed the file in tenant A's store via the test helper.
    const attached = await attachInlineForTest({
      db: ctxA.db,
      tenant_id: ctxA.tenantId,
      conversation_id: "00000000-0000-0000-0000-000000000099",
      filename: "ocpp-reference.md",
      content: OCPP_FIXTURE,
      content_type: "text/markdown",
    });

    // 2. Invoke the tool directly with a synthesised ToolContext.
    const result = await createKnowledgeSourceTool.execute(makeToolCtx(ctxA), {
      mode: "from_attachment",
      file_id: attached.file_id,
      name: "OCPP 2.0.1 Reference",
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
    expect(data.knowledge_source.name).toBe("OCPP 2.0.1 Reference");
    expect(data.knowledge_source.chunk_count).toBeGreaterThanOrEqual(2);

    const ksId = data.knowledge_source.id;

    // 3. Confirm the KS row is visible via GET /v1/knowledge-sources.
    const listRes = await journeyFetch(ctxA, "/v1/knowledge-sources");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
    const found = listBody.items.some((item) => item.id === ksId);
    expect(found).toBe(true);

    // 4. Search for "BootNotification" — must return ≥1 hit matching this KS.
    //    Invalidate cache first so the newly inserted chunks are picked up.
    invalidateKnowledgeCache(ctxA.tenantId);
    const hits = await searchKnowledge(
      { tenant_id: ctxA.tenantId, query: "BootNotification" },
      ctxA.db,
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.knowledge_source_id === ksId)).toBe(true);
  });

  // ----------------------------------------------------------------
  // AC2: cross-tenant file_id is rejected
  // ----------------------------------------------------------------

  test("AC2: file_id from tenant B is rejected with file_not_found when used from tenant A", async () => {
    // 1. Upload a file under tenant B.
    const attachedB = await attachInlineForTest({
      db: ctxB.db,
      tenant_id: ctxB.tenantId,
      conversation_id: "00000000-0000-0000-0000-000000000099",
      filename: "tenant-b-doc.md",
      content: "This document belongs to tenant B.",
      content_type: "text/markdown",
    });

    // 2. Try to ingest it from tenant A's conversation tool context.
    const result = await createKnowledgeSourceTool.execute(makeToolCtx(ctxA), {
      mode: "from_attachment",
      file_id: attachedB.file_id, // cross-tenant reference
    });

    // 3. Must fail — requireFileForTenant gates on (tenant_id, fid).
    expect(result.ok).toBe(false);
    const errData = result.data as { error: string; file_id: string };
    expect(errData.error).toBe("file_not_found");
    expect(errData.file_id).toBe(attachedB.file_id);

    // 4. No KS row written for tenant A.
    const rows = await ctxA.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.tenant_id, ctxA.tenantId));
    // Any rows that exist must have been created by AC1; none should have
    // a source_uri of "tenant-b-doc.md".
    const leaked = rows.some((r) => r.source_uri === "tenant-b-doc.md");
    expect(leaked).toBe(false);
  });
});
