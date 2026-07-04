// fetch_connector_self_description tool tests.
//
// Seeds a connector with self_description.links, mocks the driver fetch
// seam, and asserts: the live body is returned transiently, NOTHING is
// persisted (no connector-docs / knowledge-source rows), oversize bodies
// are capped, and the "no link recorded" path fires when the connector
// advertises no self-description.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  connectorDocuments,
  connectors,
  knowledgeSources,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { fetchConnectorSelfDescriptionTool } from "../fetch-connector-self-description.ts";
import type { ToolContext } from "../index.ts";

let ctx: TestDb;
let tenant_id: string;
/** Connector that advertises llms + openapi self-description links. */
let connector_with_links: string;
/** Connector with no self_description links at all. */
let connector_without_links: string;

beforeAll(async () => {
  ctx = await createTestDb("fetch_connector_self_description");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-self-desc", display_name: "T" })
    .returning();
  tenant_id = t!.id;

  const [withLinks] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "acme",
      display_name: "Acme",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.acme.test",
      config: {},
      self_description: {
        links: [
          {
            kind: "llms_full",
            url: "https://api.acme.test/llms-full.txt",
            source: "discovery",
            discovered_at: "2026-01-01T00:00:00.000Z",
          },
          {
            kind: "openapi",
            url: "https://api.acme.test/openapi.json",
            source: "discovery",
            discovered_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    })
    .returning();
  connector_with_links = withLinks!.id;

  const [withoutLinks] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "bare",
      display_name: "Bare",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.bare.test",
      config: {},
    })
    .returning();
  connector_without_links = withoutLinks!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(connector_id: string | null): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    connector_id,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

/** Fake fetch returning `body` with the given byte length. */
function fakeFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
}

async function countPersistedRows(): Promise<{ docs: number; sources: number }> {
  const docs = await ctx.db
    .select({ id: connectorDocuments.id })
    .from(connectorDocuments)
    .where(eq(connectorDocuments.tenant_id, tenant_id));
  const sources = await ctx.db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.tenant_id, tenant_id));
  return { docs: docs.length, sources: sources.length };
}

describe("fetch_connector_self_description", () => {
  test("returns the fetched body transiently and persists nothing", async () => {
    const before = await countPersistedRows();
    const result = await withDriverFetchForTests(fakeFetch("# Acme LLMs doc\nhello world"), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_with_links), { kind: "llms" }),
    );

    expect(result.ok).toBe(true);
    const data = result.data as {
      connector_slug: string;
      documents: Array<{ kind: string; url: string; body: string; truncated: boolean }>;
    };
    expect(data.connector_slug).toBe("acme");
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]!.kind).toBe("llms");
    expect(data.documents[0]!.url).toBe("https://api.acme.test/llms-full.txt");
    expect(data.documents[0]!.body).toContain("hello world");
    expect(data.documents[0]!.truncated).toBe(false);

    // Persisted NOTHING — no connector-docs, no knowledge-source rows.
    const after = await countPersistedRows();
    expect(after.docs).toBe(before.docs);
    expect(after.sources).toBe(before.sources);

    // Connector's stored self_description is untouched.
    const [row] = await ctx.db
      .select({ self_description: connectors.self_description })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_with_links)));
    expect((row!.self_description as { links: unknown[] }).links).toHaveLength(2);
  });

  test("caps oversize bodies", async () => {
    const huge = "x".repeat(200 * 1024); // 200 KB > 50 KB cap
    const result = await withDriverFetchForTests(fakeFetch(huge), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_with_links), { kind: "llms" }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      documents: Array<{ body: string; truncated: boolean }>;
    };
    expect(data.documents[0]!.truncated).toBe(true);
    expect(Buffer.byteLength(data.documents[0]!.body, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  test("returns the no-link-recorded path when self_description is empty", async () => {
    const result = await withDriverFetchForTests(fakeFetch("never called"), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_without_links), { kind: "all" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_code).toBe("no_self_description_link");
    expect(result.message).toContain("discover_connector_endpoints");
    expect(result.next_best_actions).toContain("discover_connector_endpoints");
  });

  test("returns no-connector-in-scope when none is bound", async () => {
    const result = await fetchConnectorSelfDescriptionTool.execute(makeCtx(null), { kind: "all" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_code).toBe("no_connector_in_scope");
  });
});
