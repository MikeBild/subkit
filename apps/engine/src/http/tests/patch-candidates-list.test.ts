// HTTP integration tests for GET /v1/patch-candidates list semantics.
//
// Proves the decisions-queue contract:
//   - `total` is the exact matching-row count, not the capped page length
//   - `workflow_name` joins from workflows (null when the row is gone)
//   - `order=asc` puts the oldest candidate first inside the page

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { patchCandidates, workflows } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

interface CandidateItem {
  id: string;
  workflow_id: string;
  workflow_name: string | null;
  created_at: string;
}

interface ListBody {
  items: CandidateItem[];
  total: number;
}

let srv: HttpTestServer;
let alphaId = "";
let betaId = "";
let oldestId = "";
let danglingId = "";

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
        diff: { proposal: { description: `Fix ${i}` } },
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
});

afterAll(async () => {
  await srv.cleanup();
});

function headers() {
  return { authorization: `Bearer ${srv.apiKey}` } as const;
}

describe("GET /v1/patch-candidates", () => {
  test("total is the exact count beyond the returned page", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=2`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(6);
    expect(body.total).toBeGreaterThan(body.items.length);
  });

  test("total tracks the applied filters, not the tenant-wide row count", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/patch-candidates?workflow_id=${alphaId}&limit=2`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(5);
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
    expect(ascBody.total).toBe(6);

    const desc = await fetch(`${srv.baseUrl}/v1/patch-candidates?limit=6`, { headers: headers() });
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
});
