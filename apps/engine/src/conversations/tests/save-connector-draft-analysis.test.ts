import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectorEndpointSchemas, conversations } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
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
  tenant_id = (await seedTenant(ctx.db, { slug: "t-scda", display_name: "T-SCDA" })).id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
  await attachInlineForTest({
    db: ctx.db,
    tenant_id,
    conversation_id,
    filename: "widgets.json",
    content_type: "application/json",
    content: SPEC,
    slug: "widgets-spec",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(async () => {
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
    const baseDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "Widgets",
        slug: "widgets",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://api.acme-demo.test",
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(baseDraft),
      {
        ...baseDraft.connector,
        validation: validateConnectorDraft(baseDraft.connector ?? null, []),
      },
      true,
      "Connector draft validated.",
    );
    const draftRef = {
      current: withConnectorProbe(
        validated,
        {
          ...validated.connector,
          latest_probe: {
            ok: true,
            method: "GET",
            path: "/health",
            environment: "dev",
            status_code: 200,
            summary: "ok",
          },
        },
        true,
        "ok",
      ),
    };

    const result = await saveConnectorDraftTool.execute(buildToolCtx(draftRef), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      connector: { id: string; slug: string };
      document_analysis?: { source_format: string; endpoint_count: number };
    };
    expect(data.connector.slug).toBe("widgets");
    expect(data.document_analysis).toBeDefined();
    expect(data.document_analysis!.endpoint_count).toBeGreaterThanOrEqual(2);

    const registryRows = await ctx.db
      .select()
      .from(connectorEndpointSchemas)
      .where(eq(connectorEndpointSchemas.connector_id, data.connector.id));
    expect(registryRows.length).toBeGreaterThanOrEqual(2);
    const post = registryRows.find((r) => r.method === "POST" && r.path === "/v1/widgets");
    expect(post?.expected_statuses).toContain(201);
    expect(post?.expected_statuses).toContain(422);

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
