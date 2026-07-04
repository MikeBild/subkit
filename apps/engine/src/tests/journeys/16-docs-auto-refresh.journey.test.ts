// User story: As an operator, I want connector documentation to refresh
// automatically on a schedule, so that the LLM always sees the current API.
// Acceptance criteria:
//   - AC1: A connector with auto_refresh_cron="every:1" ingests docs at boot.
//   - AC2: When the upstream OpenAPI changes, the next reconciler tick re-ingests.
//   - AC3: connector_document_chunks grows by the added-path count.
//   - AC4: connectors.last_ingested_at advances.
// Spec refs: docs/authors/authoring-workflows.md, docs/concepts/connectors.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { connectorDocumentChunks, connectors } from "../../db/schema/index.ts";
import { SchedulerReconciler } from "../../scheduler/reconciler.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

interface OpenApiPaths {
  [route: string]: Record<string, { responses: Record<string, { description: string }> }>;
}

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let connectorId = "";
let reconciler: SchedulerReconciler | null = null;
// Mutable spec served by the mock. The test swaps the object in
// between assertions to simulate an upstream shape change.
let currentPaths: OpenApiPaths = {};

function threePathSpec(): OpenApiPaths {
  return {
    "/ping": { get: { responses: { "200": { description: "ok" } } } },
    "/users": { get: { responses: { "200": { description: "list users" } } } },
    "/users/{id}": { get: { responses: { "200": { description: "show user" } } } },
  };
}

function fourPathSpec(): OpenApiPaths {
  return {
    ...threePathSpec(),
    "/widgets": { get: { responses: { "200": { description: "list widgets" } } } },
  };
}

async function countChunks(): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(connectorDocumentChunks)
    .where(
      and(
        eq(connectorDocumentChunks.tenant_id, ctx.tenantId),
        eq(connectorDocumentChunks.connector_id, connectorId),
      ),
    );
  return rows.length;
}

async function fetchConnector(): Promise<typeof connectors.$inferSelect> {
  const rows = await ctx.db.select().from(connectors).where(eq(connectors.id, connectorId));
  const row = rows[0];
  if (!row) throw new Error("connector row disappeared");
  return row;
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  stepMs: number = 100,
): Promise<boolean> {
  const tries = Math.max(1, Math.ceil(timeoutMs / stepMs));
  try {
    await waitFor(async () => ((await predicate()) ? true : undefined), {
      tries,
      sleepMs: stepMs,
      label: "waitUntil",
    });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  ctx = await createJourneyCtx("docs-refresh");

  currentPaths = threePathSpec();
  mock = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/openapi.json")) {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Auto-Refresh API", version: "1.0" },
          paths: currentPaths,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  // Seed the connector row directly so we can pin the auto-refresh cron
  // and the docs source config without bouncing through the connector
  // create REST flow.
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "auto-refresh-api",
      display_name: "Auto-Refresh API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mockBase,
      auto_refresh_cron: "every:1",
      config: {
        docs_source_type: "openapi",
        docs_source_url: `${mockBase}/openapi.json`,
      },
    })
    .returning();
  connectorId = row!.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (reconciler) await reconciler.stop();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 16: docs auto-refresh", () => {
  test(
    "AC1+AC3: initial ingest happens when reconciler boots",
    async () => {
      // 200 ms reconcile cadence so the test doesn't have to wait out
      // the 60 s production interval.
      reconciler = new SchedulerReconciler({
        boss: ctx.boss,
        db: ctx.db,
        intervalMs: 200,
      });
      await reconciler.start();

      // OpenAPI chunker emits 1 index chunk + 1 chunk per operation, so
      // a three-path spec lands at 4 chunks total. We poll until the
      // async ingest job drains.
      const ok = await waitUntil(async () => (await countChunks()) >= 4, 10_000);
      expect(ok).toBe(true);

      const connector = await fetchConnector();
      expect(connector.last_ingested_at).not.toBeNull();
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "AC2+AC4: swap upstream spec, next tick re-ingests and last_ingested_at advances",
    async () => {
      const before = await fetchConnector();
      const beforeChunks = await countChunks();
      const beforeStamp = before.last_ingested_at?.getTime() ?? 0;
      expect(beforeChunks).toBeGreaterThanOrEqual(4);

      // Flip the mock's served spec so the next reconciler tick sees the
      // new shape.
      currentPaths = fourPathSpec();

      // Give the reconciler two ticks plus the `every:1` minimum to fire.
      const grew = await waitUntil(async () => {
        const now = await countChunks();
        return now > beforeChunks;
      }, 10_000);
      expect(grew).toBe(true);

      const chunksAfter = await countChunks();
      // The new ingest adds 1 index chunk + 1 chunk per operation for
      // the fourth path. Exact arithmetic depends on dedup behaviour, so
      // we only assert that chunks grew by at least the number of newly
      // added paths.
      expect(chunksAfter - beforeChunks).toBeGreaterThanOrEqual(1);

      const after = await fetchConnector();
      const afterStamp = after.last_ingested_at?.getTime() ?? 0;
      expect(afterStamp).toBeGreaterThan(beforeStamp);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
