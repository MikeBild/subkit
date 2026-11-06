import { afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import * as discoveryService from "../../connectors/discovery/service.ts";
import { conversations as conversationsTable, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { __setMcpPoolFactoriesForTests } from "../../mcp/client/pool.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { _resetDraftCredentialCacheForTests } from "../persistence/draft-credential-cache.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

export let ctx: TestDb;
export let tenant_id: string;

export function buildBearerDraft(baseUrl: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: "do-test",
      slug: "do-test",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: baseUrl,
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
  return withConnectorProbe(validated, { ...validated.connector }, true, "ready to probe");
}

export async function seedConversation(): Promise<string> {
  const [row] = await ctx.db
    .insert(conversationsTable)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  return row!.id;
}

export async function buildToolCtx(
  conversation_id: string,
  draft: DraftDocument,
): Promise<ToolContext> {
  await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
  let liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
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
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
      liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
    },
  };
}

export let discoverySpy: ReturnType<typeof spyOn<typeof discoveryService, "runDiscoveryCached">>;

export function useDraftProbeCredentialSetup(): void {
  beforeAll(async () => {
    ctx = await createTestDb("draft_probe_credential");
    const [t] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-dpc", display_name: "T-DPC" })
      .returning();
    tenant_id = t!.id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  afterEach(() => {
    __setMcpPoolFactoriesForTests(null);
    _resetDraftCredentialCacheForTests();
  });
}

export function useDraftProbeCredentialDescribeSetup(): void {
  beforeAll(() => {
    discoverySpy = spyOn(discoveryService, "runDiscoveryCached").mockResolvedValue({
      source: "fresh",
      cache_key: "url:stub",
      result: {
        source_url: "",
        fetched_at: "2023-11-14T22:13:20.000Z",
        strategy: "graphql-introspect",
        spec_version: null,
        title: null,
        servers: [],
        auth_schemes: [],
        endpoints: [],
        warnings: [],
      },
    });
  });

  afterAll(() => {
    discoverySpy.mockRestore();
  });
}
