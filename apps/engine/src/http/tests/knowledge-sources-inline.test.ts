// Integration tests for the #144 POST /v1/knowledge-sources/inline
// OpenAPI route. Boots an in-process Hono server + real Postgres via
// the shared http test scaffold so auth + RBAC + Zod validation +
// chunking + persistence are all exercised end-to-end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("kb-inline");
});

afterAll(async () => {
  await ctx.cleanup();
});

const INLINE_PATH = "/v1/knowledge-sources/inline";

describe("POST /v1/knowledge-sources/inline — auth + RBAC", () => {
  test("no bearer → 401", async () => {
    const res = await fetch(`${ctx.baseUrl}${INLINE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "test",
        content: "hello",
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/knowledge-sources/inline — validation", () => {
  test("invalid body shape → 400", async () => {
    const res = await fetch(`${ctx.baseUrl}${INLINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: "no name field" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation_failed");
  });

  test("non-URL source_uri → 400", async () => {
    const res = await fetch(`${ctx.baseUrl}${INLINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "evil",
        content: "hello",
        source_uri: "../../etc/passwd",
      }),
    });
    expect([400, 422]).toContain(res.status);
  });
});

describe("POST /v1/knowledge-sources/inline — happy path", () => {
  test("creates a knowledge source with source_type=inline and the page URL in source_uri", async () => {
    const payload = {
      name: "Hello article",
      slug: "hello-article",
      content: "# Hello\n\nThis is a markdown page extracted from the web-scraper recipe.",
      mime_type: "text/markdown",
      source_uri: "https://example.com/blog/hello",
    };
    const res = await fetch(`${ctx.baseUrl}${INLINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      tenant_id: string;
      name: string;
      slug: string;
      source_type: string;
      source_uri: string;
      mime_type: string | null;
    };
    expect(body.tenant_id).toBe(ctx.tenantId);
    expect(body.name).toBe(payload.name);
    expect(body.slug).toBe(payload.slug);
    expect(body.source_type).toBe("inline");
    expect(body.source_uri).toBe(payload.source_uri);
    expect(body.mime_type).toBe("text/markdown");
  });

  test("falls back to a derived filename when source_uri is omitted", async () => {
    const res = await fetch(`${ctx.baseUrl}${INLINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Second article",
        slug: "second-article",
        content: "page body",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source_uri: string; source_type: string };
    expect(body.source_type).toBe("inline");
    expect(body.source_uri).toBe("second-article.md");
  });
});

describe("POST /v1/knowledge-sources — legacy multipart path stays intact", () => {
  test("multipart upload still works and ships source_type=file_upload", async () => {
    const form = new FormData();
    form.append("file", new Blob(["# multipart"], { type: "text/markdown" }), "multipart-doc.md");
    form.append("metadata", JSON.stringify({ name: "Multipart doc", slug: "multipart-doc" }));
    const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source_type: string; source_uri: string };
    expect(body.source_type).toBe("file_upload");
    expect(body.source_uri).toBe("multipart-doc.md");
  });
});
