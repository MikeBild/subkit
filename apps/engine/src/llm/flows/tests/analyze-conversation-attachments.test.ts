import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  connectorEndpointSchemas,
  connectors,
  conversations,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { analyzeConversationAttachments } from "../analyze-conversation-attachments.ts";

const nextHex = createDeterministicHexFactory(0xa11ac0);

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;
let connector_id: string;

const STRIPE_OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Stripe", version: "1.0.0" },
  paths: {
    "/v1/charges": {
      get: {
        summary: "list charges",
        responses: { "200": { description: "ok" } },
      },
      post: {
        summary: "create charge",
        responses: { "201": { description: "created" }, "402": { description: "card error" } },
      },
    },
    "/v1/customers": {
      get: { responses: { "200": { description: "ok" } } },
    },
  },
});

beforeAll(async () => {
  ctx = await createTestDb("analyze_attachments");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-aca", display_name: "T-ACA" })
    .returning();
  tenant_id = t!.id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;
  const [cn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "stripe",
      display_name: "Stripe",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.stripe.com",
    })
    .returning();
  connector_id = cn!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("analyzeConversationAttachments", () => {
  test("returns null when conversation has no attachments", async () => {
    const [emptyConv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const result = await analyzeConversationAttachments({
      tenant_id,
      conversation_id: emptyConv!.id,
      db: ctx.db,
    });
    expect(result).toBeNull();
  });

  test("parses an OpenAPI attachment and persists registry rows", async () => {
    await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id,
      filename: "stripe-spec.json",
      content_type: "application/json",
      content: STRIPE_OPENAPI,
      slug: "stripe-spec",
    });

    const result = await analyzeConversationAttachments({
      tenant_id,
      conversation_id,
      db: ctx.db,
      connector_id,
    });

    expect(result).not.toBeNull();
    expect(result!.source_format).toBe("openapi");
    expect(result!.endpoints.length).toBeGreaterThanOrEqual(3);
    expect(result!.confidence).toBeGreaterThanOrEqual(90);

    const persisted = await ctx.db
      .select()
      .from(connectorEndpointSchemas)
      .where(eq(connectorEndpointSchemas.connector_id, connector_id));
    expect(persisted.length).toBeGreaterThanOrEqual(3);
    const methodPaths = new Set(persisted.map((r) => `${r.method} ${r.path}`));
    expect(methodPaths.has("GET /v1/charges")).toBe(true);
    expect(methodPaths.has("POST /v1/charges")).toBe(true);
    const post = persisted.find((r) => r.method === "POST" && r.path === "/v1/charges");
    expect(post!.expected_statuses).toContain(201);
    expect(post!.expected_statuses).toContain(402);
  });

  test("respects slugs filter — only analyzes the requested attachments", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning();
    const tag = nextHex(4);
    const stripeTagged = JSON.stringify({
      ...JSON.parse(STRIPE_OPENAPI),
      "x-test-tag": `${tag}-a`,
    });
    await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id: conv!.id,
      filename: "spec-a.json",
      content_type: "application/json",
      content: stripeTagged,
      slug: "spec-a",
    });
    await attachInlineForTest({
      db: ctx.db,
      tenant_id,
      conversation_id: conv!.id,
      filename: "spec-b.json",
      content_type: "application/json",
      content: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "x", version: "1" },
        paths: {},
        "x-test-tag": `${tag}-b`,
      }),
      slug: "spec-b",
    });

    const onlyB = await analyzeConversationAttachments({
      tenant_id,
      conversation_id: conv!.id,
      db: ctx.db,
      slugs: ["spec-b"],
    });
    expect(onlyB).not.toBeNull();
    expect(onlyB!.endpoints).toHaveLength(0);
  });
});
