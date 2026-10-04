import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const readKey = "wf_live_ro_history_test_key_000000001";
const unrelatedKey = "wf_live_no_history_test_key_000000001";

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_history");
  await ctx.db.insert(apiKeys).values(
    [
      { key: readKey, scopes: ["workflow:read"] },
      { key: unrelatedKey, scopes: ["skill:read"] },
    ].map(({ key, scopes }) => ({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes,
    })),
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (key = ctx.apiKey): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

const currentSteps = (value: number) => [
  { kind: "transform", id: "out", language: "javascript", expression: `return ${value};` },
];

const INVALID_DAG = {
  name: "invalid-history",
  slug: "invalid-history",
  steps: [{ kind: "transform", id: "shape", language: "jsonata", expression: "$.items" }],
};

interface VersionItem {
  id: string;
  version: number;
  note: string | null;
  dag: unknown;
  invalid: boolean;
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

async function insertStoredVersion(workflow_id: string, version: number, dag: unknown) {
  await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: ctx.tenantId, workflow_id, version, dag, note: "stored earlier" });
}

async function history(id: string, query = ""): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/workflows/${id}/history${query}`, { headers: headers() });
}

describe("workflow history with a version stored under an earlier schema", () => {
  test("history lists it unchanged and marks it invalid", async () => {
    const wf = await createWorkflow("invalid-history");
    await insertStoredVersion(wf.id, 2, INVALID_DAG);

    const res = await history(wf.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: VersionItem[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((v) => v.version)).toEqual([2, 1]);

    const [invalid, current] = body.items;
    expect(current?.invalid).toBe(false);
    expect(invalid?.invalid).toBe(true);
    expect(invalid?.dag).toEqual(INVALID_DAG);
  });

  test("restoring it is a typed refusal that names the step and writes nothing", async () => {
    const wf = await createWorkflow("invalid-restore");
    await insertStoredVersion(wf.id, 2, { ...INVALID_DAG, name: "invalid-restore" });
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

    const beyond = (await (await history(wf.id, "?limit=2&offset=10")).json()) as {
      items: VersionItem[];
      total: number;
    };
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(4);
  });

  test("a read that names no limit gets one bounded page, and the total to page by", async () => {
    const wf = await createWorkflow("unpaged-history");
    for (let version = 2; version <= 61; version += 1) {
      await insertStoredVersion(wf.id, version, {
        name: "unpaged-history",
        steps: currentSteps(version),
      });
    }
    const unpaged = (await (await history(wf.id)).json()) as {
      items: VersionItem[];
      total: number;
    };
    expect(unpaged.total).toBe(61);
    expect(unpaged.items).toHaveLength(50);
    expect(unpaged.items[0]?.version).toBe(61);
    expect(unpaged.items.at(-1)?.version).toBe(12);

    const rest = (await (await history(wf.id, "?limit=200&offset=50")).json()) as {
      items: VersionItem[];
    };
    expect(rest.items.map((v) => v.version)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("a limit outside the allowed range is rejected", async () => {
    const wf = await createWorkflow("paged-history-bounds");
    expect((await history(wf.id, "?limit=0")).status).toBe(400);
    expect((await history(wf.id, "?limit=201")).status).toBe(400);
    expect((await history(wf.id, "?offset=-1")).status).toBe(400);
  });
});

describe("workflow history and restore permissions", () => {
  test("history needs workflow:read; restore needs workflow:restore", async () => {
    const wf = await createWorkflow("gated-history");
    const historyUrl = `${ctx.baseUrl}/v1/workflows/${wf.id}/history`;
    const restoreUrl = `${ctx.baseUrl}/v1/workflows/${wf.id}/restore/1`;
    const restoreAs = (key: string) => fetch(restoreUrl, { method: "POST", headers: headers(key) });

    expect((await fetch(historyUrl, { headers: headers(readKey) })).status).toBe(200);
    expect((await fetch(historyUrl, { headers: headers(unrelatedKey) })).status).toBe(403);
    expect((await restoreAs(readKey)).status).toBe(403);
    expect((await restoreAs(unrelatedKey)).status).toBe(403);
  });
});
