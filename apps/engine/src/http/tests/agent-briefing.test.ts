import { describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { files } from "../../db/schema/index.ts";
import {
  ctx,
  get,
  memberKey,
  postDomains,
  setupAgentBriefing,
  skillReadOnlyKey,
} from "./agent-briefing-fixtures.ts";

setupAgentBriefing();

describe("GET /v1/agent/briefing — auth + validation", () => {
  test("no bearer → 401", async () => {
    const res = await get("domains=blog-de");
    expect(res.status).toBe(401);
  });

  test("missing domains → 422 validation error", async () => {
    const res = await get("", ctx.apiKey);
    expect([400, 422]).toContain(res.status);
  });

  test("malformed domain slug → 400", async () => {
    const res = await get("domains=Blog%20DE!", ctx.apiKey);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  test("budget below the floor → 422", async () => {
    const res = await get("domains=blog-de&budget_tokens=10", ctx.apiKey);
    expect([400, 422]).toContain(res.status);
  });
});

describe("GET /v1/agent/briefing — happy path", () => {
  test("returns the domain-filtered briefing", async () => {
    const res = await get("domains=blog-de", ctx.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markdown: string;
      domains: string[];
      used_tokens: number;
      budget_tokens: number;
      skills_full: string[];
      knowledge_sources: string[];
    };
    expect(body.domains).toEqual(["blog-de"]);
    expect(body.markdown).toContain("Hausstil");
    expect(body.markdown).toContain("Halbgeviertstrich");
    expect(body.markdown).not.toContain("Unrelated");
    expect(body.markdown).toContain("blog-de-betrieb");
    expect(body.markdown).toContain("search_knowledge");
    expect(body.skills_full.length).toBe(1);
    expect(body.knowledge_sources).toContain("blog-de-betrieb");
    expect(body.used_tokens).toBeLessThanOrEqual(body.budget_tokens);
  });

  test("unknown domain returns the grounding rule with empty sections", async () => {
    const res = await get("domains=does-not-exist", ctx.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string; skills_full: string[] };
    expect(body.skills_full).toEqual([]);
    expect(body.markdown).toContain("# subkit session briefing");
    expect(body.markdown).not.toContain("## Conventions");
  });

  test("draft skills stay out of the briefing", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/skills`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "global",
        title: "Draft rule",
        body: "Not yet approved for sessions.",
        tags: ["domain:blog-de"],
        status: "draft",
      }),
    });
    expect([200, 201]).toContain(res.status);
    const briefing = await get("domains=blog-de", ctx.apiKey);
    const body = (await briefing.json()) as { markdown: string };
    expect(body.markdown).not.toContain("Draft rule");
  });
});

describe("GET /v1/agent/briefing — the domain's catalog", () => {
  test("lists the domain's active workflows and connectors, nothing else", async () => {
    const res = await get("domains=blog-de", ctx.apiKey);
    const body = (await res.json()) as {
      markdown: string;
      workflows: string[];
      connectors: string[];
      workflows_omitted: number;
      connectors_omitted: number;
    };
    expect(body.workflows).toEqual(["blog-de-publish"]);
    expect(body.connectors).toEqual(["blog-de-cms"]);
    expect(body.workflows_omitted).toBe(0);
    expect(body.markdown).toContain("**Artikel veröffentlichen** (`blog-de-publish`, other)");
    expect(body.markdown).toContain("**Blog CMS** (`blog-de-cms`, other)");
    expect(body.markdown).not.toContain("infra-backup");
    expect(body.markdown).not.toContain("blog-de-draft");
  });

  test("the same request returns the same JSON", async () => {
    const first = await (await get("domains=blog-de", ctx.apiKey)).json();
    const second = await (await get("domains=blog-de", ctx.apiKey)).json();
    expect(second).toEqual(first);
  });
});

describe("POST /v1/agent/domains", () => {
  test("resolves known domains from the prompt and the repository hint", async () => {
    const res = await postDomains({ prompt: "Neuer Blog Artikel, DE", repo: "infra-tools" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: ["blog-de", "infra"],
      from_prompt: ["blog-de"],
      from_repo: ["infra"],
      from_folder: [],
    });
  });

  test("resolves an exact current-folder category, including categories backed only by a file", async () => {
    const res = await postDomains({ folder: "Invoices" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: ["invoices"],
      from_prompt: [],
      from_repo: [],
      from_folder: ["invoices"],
    });
  });

  test("resolves categories contributed by every catalog kind", async () => {
    const folders = ["skill-only", "knowledge-only", "workflow-only", "connector-only"];
    for (const folder of folders) {
      const res = await postDomains({ folder });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        domains: [folder],
        from_prompt: [],
        from_repo: [],
        from_folder: [folder],
      });
    }
  });

  test("rejects a folder path so local paths cannot enter the resolver", async () => {
    const res = await postDomains({ folder: "/Users/example/invoices" });
    expect([400, 422]).toContain(res.status);
  });

  test("does not resolve categories backed only by unready or deleted files", async () => {
    for (const folder of ["unready-file", "deleted-file"]) {
      const res = await postDomains({ folder });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        domains: [],
        from_prompt: [],
        from_repo: [],
        from_folder: [],
      });
    }
  });

  test("a prompt over the limit is a validation error, not a silent cut", async () => {
    const res = await postDomains({ prompt: "x".repeat(2_001) });
    expect([400, 422]).toContain(res.status);
  });
});

describe("GET /v1/agent/briefing — catalog follows the caller's read rights", () => {
  test("a caller without connector:read sees the workflows but no connectors", async () => {
    const res = await get("domains=blog-de", await memberKey("enduser"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markdown: string;
      workflows: string[];
      connectors: string[];
    };
    expect(body.workflows).toEqual(["blog-de-publish"]);
    expect(body.connectors).toEqual([]);
    expect(body.markdown).not.toContain("## Connectors");
  });

  test("does not resolve categories supplied only by an unread connector", async () => {
    const key = await memberKey("enduser");
    const res = await fetch(`${ctx.baseUrl}/v1/agent/domains`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ folder: "connector-only" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: [],
      from_prompt: [],
      from_repo: [],
      from_folder: [],
    });
  });
});

describe("GET /v1/agent/briefing — file metadata", () => {
  test("lists only safe metadata for ready files in the requested domain", async () => {
    const res = await get("domains=invoices", ctx.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      markdown: string;
      files: Array<{
        name: string;
        slug: string | null;
        category: string;
        description: string | null;
      }>;
      files_omitted: number;
    };
    expect(body.files).toEqual([
      {
        name: "Invoice schema.csv",
        slug: null,
        category: "invoices",
        description: "Current invoice import schema.",
      },
    ]);
    expect(body.files_omitted).toBe(0);
    expect(body.markdown).toContain("## Files");
    expect(body.markdown).toContain("Invoice schema.csv");
    expect(body.markdown).not.toContain("tenant/test/invoice-schema.csv");
    expect(body.markdown).not.toContain("content_base64");
  });

  test("does not expose files without file:read", async () => {
    const res = await get("domains=invoices", await skillReadOnlyKey());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[]; markdown: string };
    expect(body.files).toEqual([]);
    expect(body.markdown).not.toContain("Invoice schema.csv");
  });

  test("budgets file metadata and reports omitted entries", async () => {
    const seeded = await ctx.db
      .insert(files)
      .values(
        Array.from({ length: 12 }, (_, index) => ({
          tenant_id: ctx.tenantId,
          status: "ready" as const,
          filename: `Budget fixture ${index}.csv`,
          storage_uri: `tenant/test/budget-fixture-${index}.csv`,
          category: "invoices",
          description: "Metadata retained only when the briefing budget permits. ".repeat(35),
        })),
      )
      .returning({ id: files.id });
    const ids = seeded.map((file) => file.id);
    try {
      const res = await get("domains=invoices&budget_tokens=500", ctx.apiKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        used_tokens: number;
        budget_tokens: number;
        files: unknown[];
        files_omitted: number;
      };
      expect(body.used_tokens).toBeLessThanOrEqual(body.budget_tokens);
      expect(body.files_omitted).toBeGreaterThan(0);
      expect(body.files.length).toBeLessThan(13);
    } finally {
      await ctx.db.delete(files).where(inArray(files.id, ids));
    }
  });
});
