import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { loadBuiltinTemplates } from "../../connectors/templates.ts";
import { connectorDocuments } from "../../db/schema/index.ts";
import { createBudgetState } from "../budgets.ts";
import { ingestTemplateDocsForConnector } from "../service.ts";
import {
  chunkGoogleDiscovery,
  fetchGoogleDiscovery,
  ingestGoogleDiscoveryUrl,
} from "../sources/google-discovery.ts";
import { createDocsTestCtx, type DocsTestCtx, stubFetch } from "./setup.ts";

const URL = "https://firestore.googleapis.com/$discovery/rest?version=v1";
const DISCOVERY = JSON.stringify({
  kind: "discovery#restDescription",
  protocol: "rest",
  title: "Cloud Firestore API",
  version: "v1",
  rootUrl: "https://firestore.googleapis.com/",
  servicePath: "",
  schemas: { Document: { type: "object", properties: { name: { type: "string" } } } },
  resources: {
    projects: {
      methods: {
        get: {
          id: "firestore.projects.get",
          httpMethod: "GET",
          path: "v1/{+name}",
          description: "Get a Firestore project resource.",
          parameters: { name: { type: "string", location: "path", required: true } },
          response: { $ref: "Document" },
        },
      },
    },
  },
});

let ctx: DocsTestCtx;

beforeAll(async () => {
  ctx = await createDocsTestCtx("google-discovery");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("Google Discovery docs ingestion", () => {
  test("fetches and validates a Discovery document", async () => {
    const fetchImpl = stubFetch({ [URL]: { body: DISCOVERY } });
    const fetched = await fetchGoogleDiscovery(URL, fetchImpl);
    expect(fetched.bytes).toBe(new TextEncoder().encode(DISCOVERY).byteLength);
    expect(fetched.parsed.kind).toBe("discovery#restDescription");
  });

  test("creates overview, method, and schema chunks", () => {
    const chunks = chunkGoogleDiscovery(JSON.parse(DISCOVERY) as Record<string, unknown>);
    expect(chunks.map((chunk) => chunk.path)).toEqual([
      "info",
      "methods.firestore.projects.get",
      "schemas.Document",
    ]);
    expect(chunks[0]?.content).toContain("server: https://firestore.googleapis.com");
    expect(chunks[1]?.content).toContain("GET /v1/{+name}");
  });

  test("records the fetched spec in the ingestion budget", async () => {
    const fetchImpl = stubFetch({ [URL]: { body: DISCOVERY } });
    const state = createBudgetState();
    const result = await ingestGoogleDiscoveryUrl(URL, state, fetchImpl);
    expect(result.uri).toBe(URL);
    expect(result.chunks).toHaveLength(3);
    expect(state.specs_fetched).toBe(1);
    expect(state.bytes_used).toBe(result.raw_bytes);
  });

  test("rejects non-Discovery JSON", async () => {
    const fetchImpl = stubFetch({ [URL]: { body: '{"openapi":"3.0.3"}' } });
    await expect(fetchGoogleDiscovery(URL, fetchImpl)).rejects.toThrow(
      "not a Google REST Discovery",
    );
  });

  test("ingests the Firebase built-in through the template lifecycle", async () => {
    const template = loadBuiltinTemplates().find((entry) => entry.slug === "firebase");
    expect(template).toBeDefined();
    expect(template?.ingestion_source).toBe("google_discovery");
    expect(template?.version).toBe(2);

    const result = await ingestTemplateDocsForConnector(
      {
        tenant_id: ctx.tenantId,
        connector_id: ctx.connectorId,
        template: template!,
        fetchImpl: stubFetch({ [URL]: { body: DISCOVERY } }),
      },
      ctx.testDb.db,
    );
    expect(result).not.toBeNull();
    expect(result?.source_type).toBe("google_discovery");
    expect(result?.ingested_count).toBe(3);

    const [document] = await ctx.testDb.db
      .select()
      .from(connectorDocuments)
      .where(
        and(
          eq(connectorDocuments.tenant_id, ctx.tenantId),
          eq(connectorDocuments.connector_id, ctx.connectorId),
        ),
      );
    expect(document?.source_type).toBe("google_discovery");
    expect(document?.chunk_count).toBe(3);
  });
});
