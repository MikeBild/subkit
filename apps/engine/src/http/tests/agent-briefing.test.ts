// Integration tests for GET /v1/agent/briefing — the SessionStart
// grounding surface for external coding agents. Boots the shared http
// scaffold (real Postgres) so auth + RBAC + Zod validation + the
// skills/knowledge domain filter run end-to-end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
  // An off-domain skill that must never leak into the briefing.
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
});

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
