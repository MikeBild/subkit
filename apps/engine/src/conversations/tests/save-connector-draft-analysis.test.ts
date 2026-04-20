// Verifies that save_connector_draft auto-runs runDocumentAnalysisFlow
// when the conversation has a structured-document attachment, persists
// rows to connector_endpoint_schemas, and emits a DOCUMENT_ANALYZED
// audit row.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectorEndpointSchemas,
  conversationAttachments,
  conversations,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { clearMemoryAttachments, putMemoryAttachment } from "../attachments.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveConnectorDraftTool } from "../tools/save-connector-draft.ts";
import type { DraftDocument } from "../types.ts";

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Widgets", version: "1.0" },
  paths: {
    "/v1/widgets": {
      get: { responses: { "200": { description: "ok" } } },
      post: {
        responses: { "201": { description: "created" }, "422": { description: "invalid" } },
      },
    },
  },
});

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("save_connector_draft_analysis");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-scda", display_name: "T-SCDA" })
    .returning();
  tenant_id = t!.id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
  // Seed the OpenAPI spec as an attachment via memory:// reader.
  const key = `${conversation_id}:widgets-spec`;
  putMemoryAttachment(key, SPEC);
  await ctx.db.insert(conversationAttachments).values({
    tenant_id,
    conversation_id,
    slug: "widgets-spec",
    original_filename: "widgets.json",
    content_type: "application/json",
    size_bytes: SPEC.length,
    storage_uri: `memory://${key}`,
    sha256: "fake",
    preview: SPEC.slice(0, 200),
  });
});

afterAll(async () => {
  clearMemoryAttachments();
  await ctx.cleanup();
});

beforeEach(async () => {
  // Clean up registry + audit between cases so assertions are precise.
  await ctx.db
    .delete(connectorEndpointSchemas)
    .where(eq(connectorEndpointSchemas.tenant_id, tenant_id));
  await ctx.db
    .delete(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "document.analyzed")));
});

function buildToolCtx(getDraftRef: { current: DraftDocument }): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => getDraftRef.current,
    setDraft: async (next) => {
      getDraftRef.current = next;
    },
    abortSignal: new AbortController().signal,
  };
}

describe("saveConnectorDraftTool — auto document analysis on attachment", () => {
  test("creates connector, persists endpoint registry rows, and emits DOCUMENT_ANALYZED", async () => {
    const draftRef = {
      current: {
        mode: "connector_authoring",
        connector: {
          name: "Widgets",
          slug: "widgets",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://api.example.com",
          latest_probe: {
            ok: true,
            method: "GET",
            path: "/health",
            environment: "dev",
            status_code: 200,
            summary: "ok",
          },
        },
        workflow: { name: "", steps: [] },
      } as DraftDocument,
    };

    const result = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), { force: false });
    expect(result.ok).toBe(true);
    const data = result.data as {
      connector: { id: string; slug: string };
      document_analysis?: { source_format: string; endpoint_count: number };
    };
    expect(data.connector.slug).toBe("widgets");
    expect(data.document_analysis).toBeDefined();
    expect(data.document_analysis!.endpoint_count).toBeGreaterThanOrEqual(2);

    // Registry persisted at least the GET + POST.
    const registryRows = await ctx.db
      .select()
      .from(connectorEndpointSchemas)
      .where(eq(connectorEndpointSchemas.connector_id, data.connector.id));
    expect(registryRows.length).toBeGreaterThanOrEqual(2);
    const post = registryRows.find((r) => r.method === "POST" && r.path === "/v1/widgets");
    expect(post?.expected_statuses).toContain(201);
    expect(post?.expected_statuses).toContain(422);

    // Audit row emitted.
    const audit = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "document.analyzed")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const meta = (audit[0]!.metadata ?? {}) as { source_format?: string; endpoint_count?: number };
    expect(meta.source_format).toBe("openapi");
    expect(meta.endpoint_count).toBeGreaterThanOrEqual(2);
  });
});
