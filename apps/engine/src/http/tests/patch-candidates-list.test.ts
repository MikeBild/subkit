// HTTP integration tests for GET /v1/patch-candidates list semantics.
//
// Proves the decisions-queue contract:
//   - `total` is the exact matching-row count, not the capped page length
//   - `workflow_name` joins from workflows (null when the row is gone)
//   - `order=asc` puts the oldest candidate first inside the page
//   - `connector_id` / `endpoint_key` — columns on `patch_candidates` that
//     were never serialized — round-trip on both the list AND the
//     single-get, and are explicit `null` (not omitted) when the signal
//     is workflow-scoped

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { connectors, patchCandidates, workflows } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

interface CandidateItem {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  connector_id: string | null;
  endpoint_key: string | null;
  created_at: string;
  reviewable: boolean;
  review_reason: string | null;
}

interface ListBody {
  items: CandidateItem[];
  total: number;
  reviewable_total: number;
}

let srv: HttpTestServer;
let alphaId = "";
let betaId = "";
let oldestId = "";
let danglingId = "";
let connectorId = "";
let endpointScopedId = "";

beforeAll(async () => {
  srv = await createHttpTestServer("patch_cand_list");
  const now = getTestNow();

  const [alpha] = await srv.db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      slug: "alpha-sync",
      name: "Alpha Sync",
      lifecycle: "active",
    })
    .returning();
  const [beta] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "beta-sync", name: "Beta Sync", lifecycle: "active" })
    .returning();
  alphaId = alpha!.id;
  betaId = beta!.id;

  // Five staggered candidates on Alpha — index 4 is the oldest.
  const rows = await srv.db
    .insert(patchCandidates)
    .values(
      [0, 1, 2, 3, 4].map((i) => ({
        tenant_id: srv.tenantId,
        workflow_id: alphaId,
        classification: "safe" as const,
        status: "proposed" as const,
        created_at: new Date(now - (i + 1) * 60_000),
        diff: { step_id: "missing-legacy-anchor", proposal: { description: `Fix ${i}` } },
      })),
    )
    .returning();
  oldestId = rows[4]!.id;

  // One candidate on Beta whose workflow row we then remove to prove the
  // LEFT JOIN degrades to a null name. The FK is ON DELETE CASCADE, so a
  // dangling workflow_id is unreachable through normal writes — drop the
  // constraint in this disposable per-suite DB to manufacture the state.
  const [dangling] = await srv.db
    .insert(patchCandidates)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: betaId,
      classification: "unsafe",
      status: "proposed",
      created_at: new Date(now),
      diff: { proposal: { description: "Beta fix" } },
    })
    .returning();
  danglingId = dangling!.id;
  await srv.db.execute(
    sql`ALTER TABLE patch_candidates DROP CONSTRAINT patch_candidates_workflow_id_workflows_id_fk`,
  );
  await srv.db.delete(workflows).where(eq(workflows.id, betaId));

  // An endpoint-scoped candidate — the drift signal's anchor endpoint —
  // carries both `connector_id` and `endpoint_key`. Alpha's other rows
  // above set neither, so they double as the "workflow-scoped, no
  // endpoint anchor" fixture.
  const [connector] = await srv.db
    .insert(connectors)
    .values({
      tenant_id: srv.tenantId,
      slug: "patch-cand-endpoint-connector",
      display_name: "Endpoint Connector",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
    })
    .returning();
  connectorId = connector!.id;
  const [endpointScoped] = await srv.db
    .insert(patchCandidates)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: alphaId,
      connector_id: connectorId,
      endpoint_key: "POST /v1/widgets",
      classification: "safe",
      status: "proposed",
      // Newer than every alpha row above (whose oldest sits at
      // now - 300_000) so it never displaces `oldestId` — this fixture is
      // only about connector_id/endpoint_key round-tripping, not ordering.
      created_at: new Date(now - 10_000),
      diff: { proposal: { description: "Endpoint-anchored fix" } },
    })
    .returning();
  endpointScopedId = endpointScoped!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

function headers() {
  return { authorization: `Bearer ${srv.apiKey}` } as const;
}

describe("GET /v1/patch-candidates", () => {
  test("non-applicable historical proposals remain visible without inflating the approval count", async () => {
    const response = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=200`, {
      headers: headers(),
    });
    const body = (await response.json()) as ListBody;
    expect(body.total).toBe(7);
    expect(body.reviewable_total).toBe(0);
    expect(body.items.every((item) => !item.reviewable && item.review_reason)).toBe(true);
    const actionable = await fetch(`${srv.baseUrl}/v1/patch-candidates?reviewable=true`, {
      headers: headers(),
    });
    expect(await actionable.json()).toMatchObject({ items: [], total: 0, reviewable_total: 0 });
    const page = await fetch(`${srv.baseUrl}/v1/patch-candidates?order=asc&limit=2&offset=2`, {
      headers: headers(),
    });
    const paged = (await page.json()) as ListBody;
    expect(paged.items).toHaveLength(2);
    expect(paged.items.some((item) => item.id === oldestId)).toBe(false);
    expect(paged.total).toBe(7);
  });
  test("total is the exact count beyond the returned page", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=2`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.length).toBe(2);
    // 5 alpha + 1 dangling(beta) + 1 endpoint-scoped(alpha) = 7.
    expect(body.total).toBe(7);
    expect(body.total).toBeGreaterThan(body.items.length);
  });

  test("total tracks the applied filters, not the tenant-wide row count", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?workflow_id=${alphaId}&limit=2`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    // 5 original alpha candidates + the endpoint-scoped one, also on alpha.
    expect(body.total).toBe(6);
  });

  test("workflow_name joins from workflows and is null when the row is gone", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=200`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    const alphaItem = body.items.find((i) => i.workflow_id === alphaId);
    expect(alphaItem?.workflow_name).toBe("Alpha Sync");
    const danglingItem = body.items.find((i) => i.id === danglingId);
    expect(danglingItem?.workflow_name).toBeNull();
  });

  test("order=asc returns the oldest candidate first; default stays newest-first", async () => {
    const asc = await fetch(`${srv.baseUrl}/v1/patch-candidates?order=asc&limit=1`, {
      headers: headers(),
    });
    expect(asc.status).toBe(200);
    const ascBody = (await asc.json()) as ListBody;
    expect(ascBody.items[0]?.id).toBe(oldestId);
    expect(ascBody.total).toBe(7);

    // limit=7 covers every seeded row so the oldest is guaranteed to be
    // the last element of the default (desc) page.
    const desc = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=7`, { headers: headers() });
    const descBody = (await desc.json()) as ListBody;
    expect(descBody.items.at(-1)?.id).toBe(oldestId);
  });

  test("get-by-id carries workflow_name", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates/${oldestId}`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CandidateItem;
    expect(body.workflow_name).toBe("Alpha Sync");
  });

  test("connector_id / endpoint_key round-trip on both the list and single-get", async () => {
    const listRes = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=200`, {
      headers: headers(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as ListBody;
    const endpointItem = listBody.items.find((i) => i.id === endpointScopedId);
    expect(endpointItem?.connector_id).toBe(connectorId);
    expect(endpointItem?.endpoint_key).toBe("POST /v1/widgets");

    const getRes = await fetch(`${srv.baseUrl}/v1/patch-candidates/${endpointScopedId}`, {
      headers: headers(),
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as CandidateItem;
    expect(getBody.connector_id).toBe(connectorId);
    expect(getBody.endpoint_key).toBe("POST /v1/widgets");
  });

  test("a workflow-scoped candidate with neither returns explicit null, not an omitted field", async () => {
    // The oldest alpha candidate never set connector_id/endpoint_key —
    // a client distinguishing "no endpoint" from "field absent" needs the
    // keys to be present with a null value, not missing from the payload.
    const getRes = await fetch(`${srv.baseUrl}/v1/patch-candidates/${oldestId}`, {
      headers: headers(),
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect("connector_id" in getBody).toBe(true);
    expect("endpoint_key" in getBody).toBe(true);
    expect(getBody.connector_id).toBeNull();
    expect(getBody.endpoint_key).toBeNull();

    const listRes = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=200`, {
      headers: headers(),
    });
    const listBody = (await listRes.json()) as ListBody;
    const oldestItem = listBody.items.find((i) => i.id === oldestId);
    expect(oldestItem).toBeDefined();
    expect(oldestItem?.connector_id).toBeNull();
    expect(oldestItem?.endpoint_key).toBeNull();
  });
});
