import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../connectors/discovery/index.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { tenants } from "../../db/schema/identity.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { DraftDocument } from "../types.ts";
import type { ToolContext } from "./index.ts";
import { startConnectorFromDescriptionTool } from "./start-connector-from-description.ts";

let ctx: TestDb;
let tenant_id: string;

const UNTEMPLATED_BASE_URL = "https://api.open-meteo.com";

const BEARER_RESULT: DiscoveryResult = {
  source_url: `${UNTEMPLATED_BASE_URL}/openapi.json`,
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "openapi-direct",
  spec_version: "openapi-3",
  title: "Untemplated API",
  servers: [UNTEMPLATED_BASE_URL],
  auth_schemes: [{ name: "bearer_auth", type: "http", scheme: "bearer" }],
  endpoints: [],
  warnings: [],
};

beforeAll(async () => {
  ctx = await createTestDb("start_connector_discovery");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-start-conn", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(async () => {
  await ctx.db.delete(knowledgeChunks);
  await ctx.db.delete(knowledgeSources);
});

interface Captured {
  draft: DraftDocument | null;
  context: ToolContext;
}

function makeCtx(): Captured {
  const captured: Captured = { draft: null, context: null as unknown as ToolContext };
  let draft: DraftDocument = { workflow: { name: "", steps: [] } } as DraftDocument;
  captured.context = {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: identifier only, never asserted on
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
      captured.draft = next;
    },
  } as ToolContext;
  return captured;
}

const ARGS = {
  name: "Open Meteo Forecast",
  description: "tomorrow's forecast for Berlin, no api key",
  base_url: UNTEMPLATED_BASE_URL,
  environment: "dev" as const,
};

describe("start_connector_from_description — discovery is best-effort", () => {
  test("an unreachable host still yields a connector draft", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockRejectedValue(
      new DiscoveryError("fetch_failed", "getaddrinfo ENOTFOUND api.open-meteo.com"),
    );
    try {
      const captured = makeCtx();
      const result = await startConnectorFromDescriptionTool.execute(captured.context, ARGS);

      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalled();

      const data = (result as { ok: true; data: Record<string, unknown> }).data;
      const connector = data.connector as { slug: string; base_url?: string; auth_type: string };
      expect(connector.slug).toBe("open-meteo-forecast");

      expect(data.recognized_auth).toBeUndefined();

      expect(captured.draft).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("a reachable host has its auth scheme recognised", async () => {
    const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(
      BEARER_RESULT,
    );
    try {
      const result = await startConnectorFromDescriptionTool.execute(makeCtx().context, ARGS);
      expect(result.ok).toBe(true);

      const data = (result as { ok: true; data: Record<string, unknown> }).data;
      expect(data.recognized_auth).toMatchObject({
        auth_type: "bearer",
        scheme_name: "bearer_auth",
        source: "discovered_security_scheme",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
