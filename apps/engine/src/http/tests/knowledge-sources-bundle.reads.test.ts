import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { apiKeys, users } from "../../db/schema/index.ts";
import { NoopScanner } from "../../files/scanner.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  enduserKey,
  postBundle,
  setupKnowledgeBundle,
  sha256Hex,
  srv,
  WIKI,
} from "./knowledge-sources-bundle-fixtures.ts";

setupKnowledgeBundle();

describe("GET /v1/knowledge-sources/{id}/chunks — full-content read", () => {
  let sourceId = "";

  beforeAll(async () => {
    const res = await postBundle(WIKI);
    const body = (await res.json()) as { knowledge_source: { id: string } };
    sourceId = body.knowledge_source.id;
  });

  test("returns full chunk content in ordinal order", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      knowledge_source_id: string;
      chunk_count: number;
      items: { ordinal: number; path: string | null; content: string }[];
    };
    expect(body.knowledge_source_id).toBe(sourceId);
    expect(body.items.length).toBe(2);
    expect(body.items.map((i) => i.ordinal)).toEqual([0, 1]);
    const deploy = body.items.find((i) => i.path === "/runbooks/deploy.md");
    expect(deploy).toBeDefined();
    expect(deploy!.content).toContain("type: Runbook");
    expect(deploy!.content).toContain("Run the deploy script.");
  });

  test("path filter narrows to one file", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks?path=${encodeURIComponent("/notes/plain.md")}`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { path: string | null }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.path).toBe("/notes/plain.md");
  });

  test("pagination via limit/offset", async () => {
    const page1 = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks?limit=1`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    const body1 = (await page1.json()) as { items: { ordinal: number }[] };
    expect(body1.items).toHaveLength(1);
    const page2 = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks?limit=1&offset=1`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    const body2 = (await page2.json()) as { items: { ordinal: number }[] };
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]!.ordinal).toBe(body1.items[0]!.ordinal + 1);
  });

  test("unknown id → 404", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/00000000-0000-0000-0000-000000000000/chunks`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    expect(res.status).toBe(404);
  });

  test("enduser (knowledge:read) can read chunks", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks`, {
      headers: { authorization: `Bearer ${enduserKey}` },
    });
    expect(res.status).toBe(200);
  });

  test("no bearer → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${sourceId}/chunks`);
    expect(res.status).toBe(401);
  });
});

describe("cross-tenant isolation on the full-content read", () => {
  test("tenant B principal cannot read tenant A's chunks (404, no leak)", async () => {
    const created = await postBundle({
      name: "Isolation Wiki",
      slug: "isolation-wiki",
      files: [{ path: "secret.md", content: "tenant A internal runbook" }],
    });
    const { knowledge_source } = (await created.json()) as { knowledge_source: { id: string } };

    const tenantB = await seedTenant(srv.db, {
      slug: "kb-bundle-b",
      display_name: "Bundle Tenant B",
    });
    const [userB] = await srv.db
      .insert(users)
      .values({
        tenant_id: tenantB.id,
        email: "admin-b@test.local",
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning();
    const randB = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
    const keyB = `wf_live_${randB}`;
    await srv.db.insert(apiKeys).values({
      tenant_id: tenantB.id,
      user_id: userB!.id,
      prefix: keyB.slice(0, 12),
      token_sha256: sha256Hex(keyB),
      scopes: ["*"],
    });

    const res = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${knowledge_source.id}/chunks`, {
      headers: { authorization: `Bearer ${keyB}` },
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("tenant A internal runbook");
  });
});

describe("POST /v1/knowledge-sources/bundle — budget mapping", () => {
  test("tenant budget exceeded → 413 content_too_large (typed-error mapping)", async () => {
    const { knowledgeSources } = await import("../../db/schema/knowledge_sources.ts");
    const [filler] = await srv.db
      .insert(knowledgeSources)
      .values({
        tenant_id: srv.tenantId,
        name: "Budget filler",
        slug: "budget-filler",
        source_type: "inline",
        source_uri: "budget-filler.md",
        version: "0".repeat(32),
        bytes_total: 500 * 1024 * 1024,
      })
      .returning({ id: knowledgeSources.id });

    try {
      const res = await postBundle({
        name: "Over Budget Wiki",
        slug: "over-budget-wiki",
        files: [{ path: "a.md", content: "tiny" }],
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("content_too_large");
    } finally {
      const { eq } = await import("drizzle-orm");
      await srv.db.delete(knowledgeSources).where(eq(knowledgeSources.id, filler!.id));
    }
  });

  test("tenant budget also gates the RE-IMPORT (outcome=updated) path → 413", async () => {
    const { knowledgeSources } = await import("../../db/schema/knowledge_sources.ts");
    const first = await postBundle({
      name: "Grow Wiki",
      slug: "grow-wiki",
      files: [{ path: "a.md", content: "small" }],
    });
    expect(first.status).toBe(200);
    const [filler] = await srv.db
      .insert(knowledgeSources)
      .values({
        tenant_id: srv.tenantId,
        name: "Budget filler 2",
        slug: "budget-filler-2",
        source_type: "inline",
        source_uri: "budget-filler-2.md",
        version: "1".repeat(32),
        bytes_total: 500 * 1024 * 1024,
      })
      .returning({ id: knowledgeSources.id });
    try {
      const res = await postBundle({
        name: "Grow Wiki",
        slug: "grow-wiki",
        files: [{ path: "a.md", content: "small but different, so it re-ingests" }],
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("content_too_large");
    } finally {
      const { eq } = await import("drizzle-orm");
      await srv.db.delete(knowledgeSources).where(eq(knowledgeSources.id, filler!.id));
    }
  });

  test("budget ALLOW side: re-import of a changed source succeeds because its own bytes are excluded", async () => {
    const { knowledgeSources } = await import("../../db/schema/knowledge_sources.ts");
    const first = await postBundle({
      name: "Exclusion Wiki",
      slug: "exclusion-wiki",
      files: [{ path: "a.md", content: `content v1 ${"x".repeat(300)}` }],
    });
    expect(first.status).toBe(200);
    const { sql } = await import("drizzle-orm");
    const [usage] = await srv.db
      .select({ total: sql<number>`coalesce(sum(${knowledgeSources.bytes_total}), 0)` })
      .from(knowledgeSources)
      .where(sql`${knowledgeSources.tenant_id} = ${srv.tenantId} AND deleted_at IS NULL`);
    const fillerBytes = 500 * 1024 * 1024 - Number(usage!.total) - 100;
    const [filler] = await srv.db
      .insert(knowledgeSources)
      .values({
        tenant_id: srv.tenantId,
        name: "Budget filler 3",
        slug: "budget-filler-3",
        source_type: "inline",
        source_uri: "budget-filler-3.md",
        version: "2".repeat(32),
        bytes_total: fillerBytes,
      })
      .returning({ id: knowledgeSources.id });
    try {
      const res = await postBundle({
        name: "Exclusion Wiki",
        slug: "exclusion-wiki",
        files: [{ path: "a.md", content: `content v2 ${"y".repeat(300)}` }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome: string };
      expect(body.outcome).toBe("updated");
    } finally {
      const { eq } = await import("drizzle-orm");
      await srv.db.delete(knowledgeSources).where(eq(knowledgeSources.id, filler!.id));
    }
  });

  test("re-homing back to global clears the stale workflow binding", async () => {
    const { workflows } = await import("../../db/schema/index.ts");
    const [wf] = await srv.db
      .insert(workflows)
      .values({
        tenant_id: srv.tenantId,
        slug: "unhome-target",
        name: "Unhome Target",
        lifecycle: "active",
      })
      .returning({ id: workflows.id });
    const bundle = {
      name: "Unhome Wiki",
      slug: "unhome-wiki",
      files: [{ path: "a.md", content: "unhome me" }],
    };
    const scoped = await postBundle({ ...bundle, scope: "workflow", workflow_id: wf!.id });
    expect(scoped.status).toBe(200);
    const back = await postBundle({ ...bundle, scope: "global" });
    expect(back.status).toBe(200);
    const body = (await back.json()) as {
      knowledge_source: { scope: string; workflow_id: string | null };
    };
    expect(body.knowledge_source.scope).toBe("global");
    expect(body.knowledge_source.workflow_id).toBeNull();
  });

  test("re-import with --scope workflow re-homes the source (no silent drop)", async () => {
    const created = await postBundle({
      name: "Rehome Wiki",
      slug: "rehome-wiki",
      files: [{ path: "a.md", content: "rehome me" }],
    });
    expect(created.status).toBe(200);
    const { workflows } = await import("../../db/schema/index.ts");
    const [wf] = await srv.db
      .insert(workflows)
      .values({
        tenant_id: srv.tenantId,
        slug: "rehome-target",
        name: "Rehome Target",
        lifecycle: "active",
      })
      .returning({ id: workflows.id });
    const res = await postBundle({
      name: "Rehome Wiki",
      slug: "rehome-wiki",
      scope: "workflow",
      workflow_id: wf!.id,
      files: [{ path: "a.md", content: "rehome me" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      knowledge_source: { scope: string; workflow_id: string | null };
    };
    expect(body.outcome).toBe("unchanged");
    expect(body.knowledge_source.scope).toBe("workflow");
    expect(body.knowledge_source.workflow_id).toBe(wf!.id);
  });
});

describe("bundle preparation retry boundary", () => {
  test("does not repeat scanning when preparation fails with a contention-shaped error", async () => {
    const scan = spyOn(NoopScanner, "scan").mockRejectedValue(
      Object.assign(new Error("scanner unavailable"), { code: "40001" }),
    );
    const store = getObjectStore();
    const put = spyOn(store, "put");
    try {
      const response = await postBundle({
        name: "Preparation retry boundary",
        slug: "preparation-retry-boundary",
        files: [{ path: "boundary.md", content: "Preparation must execute once." }],
      });
      expect(response.status).toBe(409);
      await response.arrayBuffer();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      scan.mockRestore();
      put.mockRestore();
    }
  });
});
