import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { files } from "../../db/schema/index.ts";
import {
  cleanupPersistedKnowledgeFile,
  persistKnowledgeFile,
} from "../../knowledge/file-persist.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import {
  BUNDLE_PATH,
  enduserKey,
  nextCleanupHex,
  postBundle,
  postBundleAfterCatalogConflict,
  setupKnowledgeBundle,
  srv,
  WIKI,
} from "./knowledge-sources-bundle-fixtures.ts";

setupKnowledgeBundle();

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

describe("POST /v1/knowledge-sources/bundle — create_only", () => {
  test("lost create response reconciles through slug_exists without replacing the bundle", async () => {
    const body = {
      name: "Clip collection",
      slug: "clip-collection-create-only",
      create_only: true,
      files: [{ path: "clips/first.md", content: "# First" }],
    };
    const created = await postBundle(body);
    expect(created.status).toBe(200);
    const source = (await created.json()) as { knowledge_source: { id: string } };
    const retried = await postBundle({
      ...body,
      files: [{ path: "clips/first.md", content: "# Changed after lost response" }],
    });
    expect(retried.status).toBe(409);
    expect(
      (await retried.json()) as { code: string; details: { knowledge_source_id: string } },
    ).toMatchObject({
      code: "slug_exists",
      details: { knowledge_source_id: source.knowledge_source.id },
    });
    const content = await fetch(
      `${srv.baseUrl}/v1/knowledge-sources/${source.knowledge_source.id}/content`,
      { headers: { authorization: `Bearer ${srv.apiKey}` } },
    );
    expect(content.status).toBe(200);
    expect((await content.json()) as { documents: { content: string }[] }).toMatchObject({
      documents: [{ content: "# First" }],
    });
  });

  test("concurrent create_only requests keep one source, one file, and one create audit", async () => {
    const beforeFiles = await srv.db.select().from(files).where(eq(files.tenant_id, srv.tenantId));
    const beforeObjects = await getObjectStore().list(`${srv.tenantId}/`);
    const slug = "clip-collection-concurrent-create-only";
    const [first, second] = await Promise.all([
      postBundleAfterCatalogConflict({
        name: "Concurrent clip collection",
        slug,
        create_only: true,
        files: [{ path: "clips/first.md", content: "# First concurrent" }],
      }),
      postBundleAfterCatalogConflict({
        name: "Concurrent clip collection",
        slug,
        create_only: true,
        files: [{ path: "clips/first.md", content: "# First concurrent" }],
      }),
    ]);
    const responses = [first, second];
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const created = (await responses.find((response) => response.status === 200)!.json()) as {
      knowledge_source: { id: string };
    };
    expect(
      (await responses.find((response) => response.status === 409)!.json()) as {
        code: string;
        details: { knowledge_source_id: string };
      },
    ).toMatchObject({
      code: "slug_exists",
      details: { knowledge_source_id: created.knowledge_source.id },
    });
    const afterFiles = await srv.db.select().from(files).where(eq(files.tenant_id, srv.tenantId));
    expect(afterFiles).toHaveLength(beforeFiles.length + 1);
    const afterObjects = await getObjectStore().list(`${srv.tenantId}/`);
    expect(afterObjects).toHaveLength(beforeObjects.length + 1);
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, created.knowledge_source.id),
          eq(auditLog.action, "knowledge_source.created"),
        ),
      );
    expect(audits).toHaveLength(1);
  });
});

describe("failed knowledge upload cleanup", () => {
  test("removes an unreferenced upload and keeps one a source already uses", async () => {
    const orphan = await persistKnowledgeFile(srv.db, {
      tenant_id: srv.tenantId,
      actor: null,
      upload: { buffer: `orphan ${nextCleanupHex(8)}`, filename: "orphan.md" },
    });
    expect(orphan.dedup).toBe(false);
    await cleanupPersistedKnowledgeFile(srv.db, orphan);
    const orphanRows = await srv.db.select().from(files).where(eq(files.id, orphan.row.id));
    expect(orphanRows).toHaveLength(0);

    const bundle = {
      name: "Referenced cleanup",
      slug: "referenced-cleanup",
      files: [{ path: "a.md", content: `kept ${nextCleanupHex(8)}` }],
    };
    const created = await postBundle(bundle);
    expect(created.status).toBe(200);
    const { knowledge_source } = (await created.json()) as {
      knowledge_source: { id: string; file_id: string | null };
    };
    const [stored] = await srv.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.tenant_id, srv.tenantId),
          eq(files.filename, "referenced-cleanup.bundle.json"),
        ),
      );
    if (!stored) throw new Error("bundle file not stored");
    await cleanupPersistedKnowledgeFile(srv.db, {
      row: stored,
      dedup: false,
      scan: null,
      scan_timed_out: false,
    });
    const kept = await srv.db.select().from(files).where(eq(files.id, stored.id));
    expect(kept).toHaveLength(1);
    expect(knowledge_source.id).toBeTruthy();
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
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postBundleAfterCatalogConflict(bundle)),
    );
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
