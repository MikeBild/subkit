import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let enduserKey = "";

const BUNDLE_PATH = "/v1/knowledge-sources/bundle";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

beforeAll(async () => {
  srv = await createHttpTestServer("kb-bundle");

  const [enduser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "enduser-bundle@test.local",
      role_id: await builtinRoleId(srv.db, "enduser"),
    })
    .returning();
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: enduser!.id,
    prefix: plaintext.slice(0, 12),
    token_sha256: sha256Hex(plaintext),
    scopes: ["*"],
  });
  enduserKey = plaintext;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 60_000);

function postBundle(body: unknown, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${BUNDLE_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WIKI = {
  name: "Team Wiki",
  slug: "team-wiki",
  files: [
    { path: "index.md", content: "# Team Wiki\n\n* [Deploy](runbooks/deploy.md)" },
    { path: "log.md", content: "## 2026-07-01\n* Created." },
    {
      path: "runbooks/deploy.md",
      content:
        "---\ntype: Runbook\ntitle: Deploy\ntags: [ops]\n---\n# Deploy\n\nRun the deploy script.",
    },
    { path: "notes/plain.md", content: "Plain note without frontmatter." },
  ],
};

describe("POST /v1/knowledge-sources/bundle — auth + RBAC", () => {
  test("no bearer → 401", async () => {
    const res = await fetch(`${srv.baseUrl}${BUNDLE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(WIKI),
    });
    expect(res.status).toBe(401);
  });

  test("enduser (knowledge:read only) → 403", async () => {
    const res = await postBundle(WIKI, enduserKey);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/knowledge-sources/bundle — validation", () => {
  test("missing files → 422 validation_failed", async () => {
    const res = await postBundle({ name: "no files" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_failed");
  });

  test("empty files array → 422", async () => {
    const res = await postBundle({ name: "empty", files: [] });
    expect(res.status).toBe(422);
  });
});

describe("POST /v1/knowledge-sources/bundle — upsert lifecycle", () => {
  test("create → one source, one chunk per non-reserved file, type tag mapped", async () => {
    const res = await postBundle(WIKI);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      ingested_count: number;
      skipped_count: number;
      skipped_files: string[];
      knowledge_source: {
        id: string;
        slug: string;
        source_type: string;
        tags: string[];
        chunk_count: number;
      };
    };
    expect(body.outcome).toBe("created");
    expect(body.knowledge_source.source_type).toBe("bundle");
    expect(body.knowledge_source.slug).toBe("team-wiki");
    expect(body.ingested_count).toBe(2);
    expect([...body.skipped_files].sort()).toEqual(["/index.md", "/log.md"]);
    expect(body.knowledge_source.tags).toContain("type:runbook");
    expect(body.knowledge_source.tags).toContain("ops");
  });

  test("audit row written with slug + counters", async () => {
    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, srv.tenantId), eq(auditLog.action, "knowledge_source.created")),
      );
    const bundleRow = rows.find(
      (r) => (r.metadata as Record<string, unknown>)?.slug === "team-wiki",
    );
    expect(bundleRow).toBeDefined();
    expect((bundleRow!.metadata as Record<string, unknown>).chunk_count).toBe(2);
  });

  test("unchanged re-import → outcome unchanged, no re-ingest", async () => {
    const res = await postBundle(WIKI);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; ingested_count: number };
    expect(body.outcome).toBe("unchanged");
    expect(body.ingested_count).toBe(0);
  });

  test("changed file → outcome updated, chunks rotated, new tags merge in", async () => {
    const changed = {
      ...WIKI,
      files: WIKI.files.map((f) =>
        f.path === "notes/plain.md"
          ? {
              path: f.path,
              content: "---\ntype: Decision\n---\nNow a typed decision note.",
            }
          : f,
      ),
    };
    const res = await postBundle(changed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      ingested_count: number;
      knowledge_source: { tags: string[] };
    };
    expect(body.outcome).toBe("updated");
    expect(body.ingested_count).toBe(2);
    expect(body.knowledge_source.tags).toContain("type:runbook");
    expect(body.knowledge_source.tags).toContain("type:decision");
  });

  test("slug owned by a non-bundle source → 409 slug_conflict", async () => {
    const inline = await fetch(`${srv.baseUrl}/v1/knowledge-sources/inline`, {
      method: "POST",
      headers: { authorization: `Bearer ${srv.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Inline doc", slug: "inline-owned", content: "# hi" }),
    });
    expect(inline.status).toBe(201);
    const res = await postBundle({
      name: "Bundle steals slug",
      slug: "inline-owned",
      files: [{ path: "a.md", content: "x" }],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("slug_conflict");
  });

  test("searchable right after import, narrowed by the structural type tag", async () => {
    const res = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/search?q=deploy%20script&tags=type:runbook`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: { source_name: string; path: string | null }[] };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.source_name).toBe("Team Wiki");
  });
});

describe("POST /v1/knowledge-sources/bundle — review-verified edge cases", () => {
  test("delete then re-import under the same slug creates cleanly (partial unique index)", async () => {
    const bundle = {
      name: "Deleted Wiki",
      slug: "deleted-wiki",
      files: [{ path: "a.md", content: "alpha" }],
    };
    const first = await postBundle(bundle);
    expect(first.status).toBe(200);
    const { knowledge_source } = (await first.json()) as { knowledge_source: { id: string } };
    const del = await fetch(`${srv.baseUrl}/v1/knowledge-sources/${knowledge_source.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(del.status).toBe(200);
    const again = await postBundle(bundle);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { outcome: string; knowledge_source: { id: string } };
    expect(body.outcome).toBe("created");
    expect(body.knowledge_source.id).not.toBe(knowledge_source.id);
  });

  test("unchanged content but new tags → outcome unchanged AND tags applied", async () => {
    const bundle = {
      name: "Retag Wiki",
      slug: "retag-wiki",
      files: [{ path: "a.md", content: "alpha" }],
    };
    const first = await postBundle(bundle);
    expect(first.status).toBe(200);
    const second = await postBundle({ ...bundle, tags: ["domain:sales"] });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      outcome: string;
      knowledge_source: { tags: string[] };
    };
    expect(body.outcome).toBe("unchanged");
    expect(body.knowledge_source.tags).toContain("domain:sales");
  });

  test("two identical files at different paths BOTH stay readable (no cross-path dedup)", async () => {
    const same = "# Template\n\nIdentical boilerplate body.";
    const res = await postBundle({
      name: "Twin Wiki",
      slug: "twin-wiki",
      files: [
        { path: "daily/mon.md", content: same },
        { path: "daily/tue.md", content: same },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ingested_count: number;
      knowledge_source: { id: string };
    };
    expect(body.ingested_count).toBe(2);
    for (const p of ["/daily/mon.md", "/daily/tue.md"]) {
      const read = await fetch(
        `${srv.baseUrl}/v1/knowledge-sources/${body.knowledge_source.id}/chunks?path=${encodeURIComponent(p)}`,
        { headers: { authorization: `Bearer ${srv.apiKey}` } },
      );
      const rb = (await read.json()) as { items: unknown[] };
      expect(rb.items).toHaveLength(1);
    }
  });

  test("no cross-path dedup holds on the RE-INGEST path too (outcome=updated)", async () => {
    const same = "# Template\n\nIdentical boilerplate body.";
    const res = await postBundle({
      name: "Twin Wiki",
      slug: "twin-wiki",
      files: [
        { path: "daily/mon.md", content: same },
        { path: "daily/tue.md", content: same },
        { path: "readme.md", content: "changed so the bundle re-ingests" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      ingested_count: number;
      knowledge_source: { id: string };
    };
    expect(body.outcome).toBe("updated");
    expect(body.ingested_count).toBe(3);
    for (const p of ["/daily/mon.md", "/daily/tue.md"]) {
      const read = await fetch(
        `${srv.baseUrl}/v1/knowledge-sources/${body.knowledge_source.id}/chunks?path=${encodeURIComponent(p)}`,
        { headers: { authorization: `Bearer ${srv.apiKey}` } },
      );
      const rb = (await read.json()) as { items: unknown[] };
      expect(rb.items).toHaveLength(1);
    }
  });

  test("chunk path reads back with the literal string the client sent (no leading slash)", async () => {
    const res = await postBundle({
      name: "Literal Path Wiki",
      slug: "literal-path-wiki",
      files: [{ path: "runbooks/deploy.md", content: "deploy body" }],
    });
    const body = (await res.json()) as { knowledge_source: { id: string } };
    const read = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/${body.knowledge_source.id}/chunks?path=${encodeURIComponent("runbooks/deploy.md")}`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    const rb = (await read.json()) as { items: { content: string }[] };
    expect(rb.items).toHaveLength(1);
    expect(rb.items[0]!.content).toBe("deploy body");
  });

  test("non-ASCII names slugify to distinct fallback slugs — no silent cross-overwrite", async () => {
    const a = await postBundle({
      name: "日本語ノート",
      files: [{ path: "a.md", content: "japanese" }],
    });
    expect(a.status).toBe(200);
    const aBody = (await a.json()) as { outcome: string; knowledge_source: { slug: string } };
    expect(aBody.outcome).toBe("created");
    expect(aBody.knowledge_source.slug).not.toBe("");

    const b = await postBundle({
      name: "справочник",
      files: [{ path: "b.md", content: "russian" }],
    });
    expect(b.status).toBe(200);
    const bBody = (await b.json()) as { outcome: string; knowledge_source: { slug: string } };
    expect(bBody.outcome).toBe("created");
    expect(bBody.knowledge_source.slug).not.toBe(aBody.knowledge_source.slug);
  });

  test("scope=workflow without workflow_id → 422 validation error, not 500", async () => {
    const res = await postBundle({
      name: "Scoped Wiki",
      scope: "workflow",
      files: [{ path: "a.md", content: "x" }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_failed");
  });

  test("re-import with new --description lands on the unchanged path", async () => {
    const bundle = {
      name: "Described Wiki",
      slug: "described-wiki",
      files: [{ path: "a.md", content: "alpha" }],
    };
    const first = await postBundle(bundle);
    expect(first.status).toBe(200);
    const second = await postBundle({ ...bundle, description: "Q3 revision" });
    const body = (await second.json()) as {
      outcome: string;
      knowledge_source: { description: string | null };
    };
    expect(body.outcome).toBe("unchanged");
    expect(body.knowledge_source.description).toBe("Q3 revision");
  });

  test("20 caller tags cannot displace structural type:* tags (routing keys survive the cap)", async () => {
    const callerTags = Array.from({ length: 20 }, (_, i) => `topic-${i}`);
    const res = await postBundle({
      name: "Capped Wiki",
      slug: "capped-wiki",
      tags: callerTags,
      files: [{ path: "r.md", content: "---\ntype: Runbook\n---\nbody" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knowledge_source: { tags: string[] } };
    expect(body.knowledge_source.tags).toContain("type:runbook");
    expect(body.knowledge_source.tags).toHaveLength(20);
  });

  test("concurrent first imports of one new slug all resolve via the upsert contract (no 500)", async () => {
    const bundle = {
      name: "Race Wiki",
      slug: "race-wiki",
      files: [{ path: "a.md", content: "raced" }],
    };
    const responses = await Promise.all(Array.from({ length: 6 }, () => postBundle(bundle)));
    for (const res of responses) expect(res.status).toBe(200);
    const outcomes = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { outcome: string }).outcome),
    );
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    const list = await fetch(`${srv.baseUrl}/v1/knowledge-sources?limit=500`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    const { items } = (await list.json()) as { items: { slug: string }[] };
    expect(items.filter((i) => i.slug === "race-wiki")).toHaveLength(1);
  });

  test("log.md-only change is a no-op re-import (agent-wiki session churn)", async () => {
    const files = [
      { path: "log.md", content: "## 2026-07-01\n* created" },
      { path: "c.md", content: "concept" },
    ];
    const first = await postBundle({ name: "Log Churn Wiki", slug: "log-churn-wiki", files });
    expect(first.status).toBe(200);
    const second = await postBundle({
      name: "Log Churn Wiki",
      slug: "log-churn-wiki",
      files: [{ path: "log.md", content: "## 2026-07-16\n* another session" }, files[1]!],
    });
    const body = (await second.json()) as { outcome: string };
    expect(body.outcome).toBe("unchanged");
  });
});

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

    const { tenants } = await import("../../db/schema/index.ts");
    const [tenantB] = await srv.db
      .insert(tenants)
      .values({ slug: "kb-bundle-b", display_name: "Bundle Tenant B" })
      .returning();
    const [userB] = await srv.db
      .insert(users)
      .values({
        tenant_id: tenantB!.id,
        email: "admin-b@test.local",
        role_id: await builtinRoleId(srv.db, "admin"),
      })
      .returning();
    const randB = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
    const keyB = `wf_live_${randB}`;
    await srv.db.insert(apiKeys).values({
      tenant_id: tenantB!.id,
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
