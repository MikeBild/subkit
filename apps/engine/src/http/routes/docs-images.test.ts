import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import { createDbFromUrl } from "../../db/client.ts";
import { DOCS_IMAGES, type EmbeddedDocsImage } from "../docs-images-embedded.ts";
import type { AppEnv } from "../openapi.ts";
import { createApp } from "../server.ts";
import { registerDocsImageRoutes } from "./docs-images.ts";

const offlineDb = createDbFromUrl("postgres://localhost/offline").db;

const FILE = "first-run-result.en.webp";

let dir: string;
let bytes: Uint8Array<ArrayBuffer>;
let sha: string;
let images: Record<string, EmbeddedDocsImage>;

function webp(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(30);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 22, true);
  out.set(new TextEncoder().encode("WEBPVP8L"), 8);
  new DataView(out.buffer).setUint32(16, 10, true);
  out[20] = 0x2f;
  return out;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sk-docs-images-"));
  bytes = webp();
  sha = createHash("sha256").update(bytes).digest("hex");
  const path = join(dir, FILE);
  writeFileSync(path, bytes);
  images = { [FILE]: { path, sha256: sha, bytes: bytes.byteLength } };
  _resetConfigForTests();
  await loadConfig({
    configPathOverride: join(dir, "subkit.config.json"),
    env: { DATABASE_URL: "postgres://localhost/docs_images_fixture", NODE_ENV: "test" },
  });
});

afterAll(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

function app(): OpenAPIHono<AppEnv> {
  const built = new OpenAPIHono<AppEnv>();
  registerDocsImageRoutes(built, images);
  return built;
}

function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(app().request(`http://127.0.0.1${path}`, { method, headers }));
}

describe("GET /docs-images/{file}", () => {
  test("serves the image forever when v matches its sha", async () => {
    const res = await request(`/docs-images/${FILE}?v=${sha.slice(0, 12)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("etag")).toBe(`"${sha}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test.each([
    ["without v", `/docs-images/${FILE}`],
    ["with a stale v", `/docs-images/${FILE}?v=000000000000`],
  ])("caches briefly %s", async (_name, path) => {
    const res = await request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("answers HEAD with the headers and no body", async () => {
    const res = await request(`/docs-images/${FILE}`, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test.each([
    ["an unknown file", "/docs-images/missing.en.webp"],
    ["an upper-case name", "/docs-images/First-run-result.en.webp"],
    ["an encoded traversal", "/docs-images/..%2Fmanifest.json"],
    ["a wrong extension", "/docs-images/first-run-result.en.png"],
    ["a missing locale", "/docs-images/first-run-result.webp"],
  ])("answers 404 for %s", async (_name, path) => {
    const res = await request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toStartWith("Not found: /docs-images/");
  });

  test.each([
    ["its ETag", (tag: string) => tag],
    ["a weak ETag in a list", (tag: string) => `"other", W/${tag}`],
    ["a wildcard", () => "*"],
  ])("answers 304 without a body when If-None-Match carries %s", async (_name, header) => {
    const res = await request(`/docs-images/${FILE}?v=${sha.slice(0, 12)}`, "GET", {
      "if-none-match": header(`"${sha}"`),
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${sha}"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("sends the bytes when If-None-Match names another ETag", async () => {
    const res = await request(`/docs-images/${FILE}`, "GET", { "if-none-match": '"other"' });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("the full engine answers an anonymous caller and keeps /docs on Scalar", async () => {
    const engine = createApp({ db: offlineDb, rateLimit: { max: 10_000, windowMs: 60_000 } });
    const missing = await engine.request("http://127.0.0.1/docs-images/missing.en.webp");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found: /docs-images/missing.en.webp\n");
    const docs = await engine.request("http://127.0.0.1/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
  });

  test("the full engine serves an embedded screenshot with its image headers", async () => {
    const [file, image] = Object.entries(DOCS_IMAGES)[0] ?? [];
    if (!file || !image) throw new Error("no embedded docs image");
    const engine = createApp({ db: offlineDb, rateLimit: { max: 10_000, windowMs: 60_000 } });
    const res = await engine.request(
      `http://127.0.0.1/docs-images/${file}?v=${image.sha256.slice(0, 12)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(`"${image.sha256}"`);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(image.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(image.sha256);
  });

  test("the OpenAPI document lists the route as a WebP binary", async () => {
    const engine = createApp({ db: offlineDb, rateLimit: { max: 10_000, windowMs: 60_000 } });
    const spec = (await (await engine.request("http://127.0.0.1/openapi.json")).json()) as {
      paths: Record<string, { get?: { tags?: string[]; responses: Record<string, unknown> } }>;
    };
    const operation = spec.paths["/docs-images/{file}"]?.get;
    expect(operation?.tags).toEqual(["docs"]);
    expect(JSON.stringify(operation?.responses["200"])).toContain('"format":"binary"');
  });
});
