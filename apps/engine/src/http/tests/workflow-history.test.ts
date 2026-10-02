// Workflow version history and restore over the HTTP surface.
//
//   * GET /v1/workflows/:id/history is a read-only view of what was stored.
//     A version saved under an earlier definition schema is listed with its
//     dag unchanged and `legacy: true` — it does not fail the whole list.
//   * POST /v1/workflows/:id/restore/:version stays strict: a version that no
//     longer validates is refused with a typed `version_not_restorable`, and
//     the refusal writes nothing.
//   * History is newest first; `limit` / `offset` page it in the query and
//     `total` is the exact count regardless of the page.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_history");
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

const currentSteps = (value: number) => [
  { kind: "transform", id: "out", language: "javascript", expression: `return ${value};` },
];

// A definition as it was valid under an earlier schema: `jsonata` is no longer
// a transform language, so today's schema rejects the step.
const LEGACY_DAG = {
  name: "legacy-history",
  slug: "legacy-history",
  steps: [{ kind: "transform", id: "shape", language: "jsonata", expression: "$.items" }],
};

interface VersionItem {
  id: string;
  version: number;
  note: string | null;
  dag: unknown;
  legacy: boolean;
}

async function createWorkflow(name: string): Promise<{ id: string }> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, slug: name, steps: currentSteps(1) }),
  });
  if (!res.ok) throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

async function updateWorkflow(id: string, name: string, value: number): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ name, slug: name, steps: currentSteps(value) }),
  });
  if (!res.ok) throw new Error(`workflow update failed: ${res.status} ${await res.text()}`);
}

/** Store a version the way an earlier engine wrote it — straight into the
 *  table, because the current write path would refuse the definition. */
async function insertStoredVersion(workflow_id: string, version: number, dag: unknown) {
  await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id, version, dag, note: "stored earlier" });
}

async function history(id: string, query = ""): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/workflows/${id}/history${query}`, { headers: headers() });
}

describe("workflow history with a version stored under an earlier schema", () => {
  test("history lists it unchanged and marks it legacy", async () => {
    const wf = await createWorkflow("legacy-history");
    await insertStoredVersion(wf.id, 2, LEGACY_DAG);

    const res = await history(wf.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: VersionItem[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((v) => v.version)).toEqual([2, 1]);

    const [legacy, current] = body.items;
    expect(current?.legacy).toBe(false);
    expect(legacy?.legacy).toBe(true);
    // The stored definition comes back as stored — not parsed, defaulted or
    // stripped on the way out.
    expect(legacy?.dag).toEqual(LEGACY_DAG);
  });

  test("restoring it is a typed refusal that names the step and writes nothing", async () => {
    const wf = await createWorkflow("legacy-restore");
    await insertStoredVersion(wf.id, 2, { ...LEGACY_DAG, name: "legacy-restore" });
    const [before] = await ctx.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/restore/2`, {
      method: "POST",
      headers: headers(),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details?: { version: number; issues: Array<{ path: string; step_id: string | null }> };
    };
    expect(body.code).toBe("version_not_restorable");
    expect(body.message).toContain('step "shape"');
    expect(body.message).toContain("steps.0.language");
    expect(body.details?.version).toBe(2);
    expect(body.details?.issues[0]).toMatchObject({
      path: "steps.0.language",
      step_id: "shape",
    });

    // The refusal happens before any write: no restored version row, and the
    // workflow still points at the version it pointed at.
    const stored = await ctx.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.workflow_id, wf.id)),
      );
    expect(stored.map((v) => v.version).sort()).toEqual([1, 2]);
    const [after] = await ctx.db
      .select({ current_version_id: workflows.current_version_id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, wf.id)));
    expect(after?.current_version_id).toBe(before?.current_version_id ?? null);
  });

  test("a version that still validates restores as before", async () => {
    const wf = await createWorkflow("current-restore");
    await updateWorkflow(wf.id, "current-restore", 2);

    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/restore/1`, {
      method: "POST",
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current_version: number };
    expect(body.current_version).toBe(3);
  });
});

describe("workflow history pagination", () => {
  test("limit and offset page the versions; total stays exact", async () => {
    const wf = await createWorkflow("paged-history");
    await updateWorkflow(wf.id, "paged-history", 2);
    await updateWorkflow(wf.id, "paged-history", 3);
    await updateWorkflow(wf.id, "paged-history", 4);

    const all = (await (await history(wf.id)).json()) as { items: VersionItem[]; total: number };
    expect(all.items.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(all.total).toBe(4);

    const head = (await (await history(wf.id, "?limit=2")).json()) as {
      items: VersionItem[];
      total: number;
    };
    expect(head.items.map((v) => v.version)).toEqual([4, 3]);
    expect(head.total).toBe(4);

    const page = (await (await history(wf.id, "?limit=2&offset=1")).json()) as {
      items: VersionItem[];
      total: number;
    };
    expect(page.items.map((v) => v.version)).toEqual([3, 2]);
    expect(page.total).toBe(4);

    // Paging past the end is an empty page, not a wrong total.
    const beyond = (await (await history(wf.id, "?limit=2&offset=10")).json()) as {
      items: VersionItem[];
      total: number;
    };
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(4);
  });

  test("a limit outside the allowed range is rejected", async () => {
    const wf = await createWorkflow("paged-history-bounds");
    expect((await history(wf.id, "?limit=0")).status).toBe(400);
    expect((await history(wf.id, "?limit=201")).status).toBe(400);
    expect((await history(wf.id, "?offset=-1")).status).toBe(400);
  });
});
