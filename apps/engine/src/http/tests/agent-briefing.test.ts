import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, connectors, users, workflows } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

const PATH = "/v1/agent/briefing";

async function get(query: string, key?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${PATH}?${query}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("agent-briefing");

  const post = (path: string, body: unknown) =>
    fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const skillRes = await post("/v1/skills", {
    scope: "global",
    title: "Hausstil",
    body: "Immer Halbgeviertstrich mit Leerzeichen als Gedankenstrich verwenden.",
    tags: ["domain:blog-de"],
    status: "active",
  });
  if (skillRes.status !== 201 && skillRes.status !== 200) {
    throw new Error(`seed skill failed: ${skillRes.status} ${await skillRes.text()}`);
  }
  await post("/v1/skills", {
    scope: "global",
    title: "Unrelated",
    body: "Belongs to another domain entirely.",
    tags: ["domain:infra"],
    status: "active",
  });

  const ksRes = await post("/v1/knowledge-sources/inline", {
    name: "Blog Betrieb",
    slug: "blog-de-betrieb",
    content: "# Betrieb\n\nRelease-Reihenfolge und Gotchas.",
    tags: ["domain:blog-de"],
  });
  if (ksRes.status !== 201) {
    throw new Error(`seed knowledge failed: ${ksRes.status} ${await ksRes.text()}`);
  }

  await ctx.db.insert(workflows).values([
    {
      tenant_id: ctx.tenantId,
      slug: "blog-de-publish",
      name: "Artikel veröffentlichen",
      description: "Publishes a reviewed article.",
      lifecycle: "active",
    },
    { tenant_id: ctx.tenantId, slug: "infra-backup", name: "Backup", lifecycle: "active" },
    { tenant_id: ctx.tenantId, slug: "blog-de-draft", name: "Entwurf", lifecycle: "draft" },
  ]);
  await ctx.db.insert(connectors).values([
    { tenant_id: ctx.tenantId, slug: "blog-de-cms", display_name: "Blog CMS", driver: "http" },
    { tenant_id: ctx.tenantId, slug: "infra-dns", display_name: "DNS", driver: "http" },
  ]);
});

async function memberKey(role: string): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `${role}-briefing@test.local`,
      role_id: await builtinRoleId(ctx.db, role),
    })
    .returning();
  const key = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`; // allow-random: test only
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: user?.id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
  });
  return key;
}

afterAll(async () => {
  await ctx.cleanup();
});

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
    expect(body.markdown).toContain("# sk session briefing");
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

function postDomains(body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/agent/domains`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/agent/domains", () => {
  test("resolves known domains from the prompt and the repository hint", async () => {
    const res = await postDomains({ prompt: "Neuer Blog Artikel, DE", repo: "infra-tools" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: ["blog-de", "infra"],
      from_prompt: ["blog-de"],
      from_repo: ["infra"],
    });
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
});
