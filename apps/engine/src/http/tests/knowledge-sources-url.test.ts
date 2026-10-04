import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let page: Server;
let pageOrigin = "";
let pageBody = "<html><body><h1>Rückgaben</h1><p>Innerhalb von 30 Tagen.</p></body></html>";

beforeAll(async () => {
  ctx = await createHttpTestServer("kb-url");
  page = createServer((req, res) => {
    if (req.url === "/missing") {
      res.writeHead(404).end("gone");
      return;
    }
    if (req.url === "/image") {
      res.writeHead(200, { "content-type": "image/png" }).end("png");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageBody);
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const address = page.address();
  if (address === null || typeof address === "string") throw new Error("no page server port");
  pageOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  page.closeAllConnections?.();
  await new Promise<void>((resolve) => page.close(() => resolve()));
  await ctx.cleanup();
});

const pageUrl = (path: string) => `${pageOrigin}${path}`;

async function post(path: string, body?: unknown) {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Source {
  id: string;
  name: string;
  source_type: string;
  source_uri: string;
  chunk_count: number;
  last_refreshed_at: string | null;
}

async function chunkText(id: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources/${id}/chunks`, {
    headers: { authorization: `Bearer ${ctx.apiKey}` },
  });
  const body = (await res.json()) as { items: { content: string }[] };
  return body.items.map((item) => item.content).join("\n");
}

describe("POST /v1/knowledge-sources/url", () => {
  test("no bearer → 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/knowledge-sources/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: pageUrl("/returns") }),
    });
    expect(res.status).toBe(401);
  });

  test("reads the page, stores its text as Markdown and keeps the address", async () => {
    const res = await post("/v1/knowledge-sources/url", { url: pageUrl("/returns") });
    expect(res.status).toBe(201);
    const source = (await res.json()) as Source;
    expect(source.source_type).toBe("url");
    expect(source.source_uri).toBe(pageUrl("/returns"));
    expect(source.name).toBe(`${pageOrigin.replace("http://", "")}/returns`);
    expect(source.chunk_count).toBeGreaterThan(0);
    const text = await chunkText(source.id);
    expect(text).toContain("Innerhalb von 30 Tagen.");
    expect(text).not.toContain("<p>");
  });

  test("a page that answers 404 is refused with 422", async () => {
    const res = await post("/v1/knowledge-sources/url", { url: pageUrl("/missing"), name: "Weg" });
    expect(res.status).toBe(422);
  });

  test("an address that is not text is refused with 422", async () => {
    const res = await post("/v1/knowledge-sources/url", { url: pageUrl("/image"), name: "Bild" });
    expect(res.status).toBe(422);
  });
});

describe("POST /v1/knowledge-sources/{id}/refresh", () => {
  test("reads the address again and replaces the content", async () => {
    pageBody = "<html><body><p>Erste Fassung.</p></body></html>";
    const created = (await (
      await post("/v1/knowledge-sources/url", { url: pageUrl("/policy"), name: "Richtlinie" })
    ).json()) as Source;
    pageBody = "<html><body><p>Zweite Fassung.</p></body></html>";
    const res = await post(`/v1/knowledge-sources/${created.id}/refresh`);
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as Source;
    expect(refreshed.source_uri).toBe(pageUrl("/policy"));
    expect(refreshed.last_refreshed_at).not.toBeNull();
    const text = await chunkText(created.id);
    expect(text).toContain("Zweite Fassung.");
    expect(text).not.toContain("Erste Fassung.");
  });

  test("a source without an address is refused with 409", async () => {
    const inline = (await (
      await post("/v1/knowledge-sources/inline", { name: "Eigener Text", content: "# Regeln" })
    ).json()) as Source;
    const res = await post(`/v1/knowledge-sources/${inline.id}/refresh`);
    expect(res.status).toBe(409);
  });

  test("an unknown source is 404", async () => {
    const res = await post("/v1/knowledge-sources/00000000-0000-4000-8000-000000000000/refresh");
    expect(res.status).toBe(404);
  });
});
