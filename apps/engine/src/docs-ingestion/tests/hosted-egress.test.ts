import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { _withEgressLookupForTests } from "../../connectors/egress-guard.ts";
import { connectorDocuments, connectors, tenants } from "../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../execution/tenant-work.ts";
import { logger } from "../../logging/index.ts";
import { ingestDocs } from "../service.ts";
import type { DocSourceType } from "../types.ts";
import { createDocsTestCtx, type DocsTestCtx } from "./setup.ts";

let ctx: DocsTestCtx;
beforeAll(async () => {
  ctx = await createDocsTestCtx("docs-hosted-egress", { hosted: true });
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
const publicAddress = "93.184.216.34";
const spec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Synthetic", version: "test" },
  paths: {
    "/items": {
      get: { summary: "List synthetic items", responses: { "200": { description: "items" } } },
    },
  },
});
function transport(respond: (url: URL) => Response) {
  const calls: Array<{
    ip: string;
    host: string | null;
    path: string;
    authorization: string | null;
  }> = [];
  const fetchImpl = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        ip: url.hostname,
        host: headers.get("host"),
        path: url.pathname,
        authorization: headers.get("authorization"),
      });
      return respond(url);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return { calls, fetchImpl };
}
function ingest(source_type: DocSourceType, url: string, fetchImpl: typeof fetch) {
  return ingestDocs(
    {
      tenant_id: ctx.tenantId,
      connector_id: ctx.connectorId,
      input: { source_type, url },
      fetchImpl,
    },
    ctx.testDb.db,
  );
}

test("hosted documentation never dispatches private primary URLs", async () => {
  const mock = transport(() => {
    throw new Error("must not dispatch");
  });
  for (const source of [
    "openapi",
    "google_discovery",
    "markdown",
    "llms_txt",
    "graphql",
    "cascade",
  ] as const) {
    await expect(ingest(source, "http://127.0.0.1/private", mock.fetchImpl)).rejects.toThrow();
  }
  expect(mock.calls).toHaveLength(0);
});

test("hosted documentation redirects revalidate DNS and never dispatch private or credential-bearing targets", async () => {
  for (const location of [
    "http://127.0.0.1/private",
    "https://user:secret@other.example.test/private",
    "/rebound",
  ]) {
    let reads = 0;
    const mock = transport(() => new Response(null, { status: 307, headers: { location } }));
    await _withEgressLookupForTests(
      async () => {
        reads += 1;
        return [{ address: reads === 1 ? publicAddress : "127.0.0.1", family: 4 }];
      },
      async () => {
        await expect(
          ingest("markdown", "https://docs.example.test/start", mock.fetchImpl),
        ).rejects.toThrow();
      },
    );
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      ip: publicAddress,
      host: "docs.example.test",
      authorization: null,
    });
  }
});

test("OpenAPI external refs and llms links retain the guarded transport", async () => {
  const referenced = JSON.parse(spec) as { components?: unknown };
  referenced.components = {
    schemas: {
      Private: { $ref: "http://127.0.0.1/private" },
      Credentials: { $ref: "https://user:secret@other.example.test/ref" },
      Public: { $ref: "https://reference.example.test/public.json" },
    },
  };
  const mock = transport((url) => {
    if (url.pathname === "/root.json") return Response.json(referenced);
    if (url.pathname === "/llms.txt")
      return new Response(
        "# Synthetic\n\n- [Public](https://reference.example.test/public.json)\n- [Private](http://127.0.0.1/private)\n",
      );
    return new Response(spec, { headers: { "content-type": "application/json" } });
  });
  await _withEgressLookupForTests(
    async () => [{ address: publicAddress, family: 4 }],
    async () => {
      expect(
        (await ingest("openapi", "https://docs.example.test/root.json", mock.fetchImpl))
          .ingested_count,
      ).toBeGreaterThan(0);
      expect(
        (await ingest("llms_txt", "https://docs.example.test/llms.txt", mock.fetchImpl))
          .ingested_count,
      ).toBeGreaterThan(0);
    },
  );
  expect(mock.calls.some((call) => call.host === "reference.example.test")).toBe(true);
  expect(mock.calls.every((call) => call.ip === publicAddress && call.authorization === null)).toBe(
    true,
  );
  expect(mock.calls.some((call) => call.path === "/private")).toBe(false);
});

test("cascade discovery uses the same pinned transport for candidate probes and fetched specifications", async () => {
  const mock = transport((url) =>
    url.pathname === "/openapi.json"
      ? new Response(spec, { headers: { "content-type": "application/json" } })
      : new Response("missing", { status: 404 }),
  );
  await _withEgressLookupForTests(
    async () => [{ address: publicAddress, family: 4 }],
    async () => {
      expect(
        (await ingest("cascade", "https://cascade.example.test/", mock.fetchImpl)).ingested_count,
      ).toBeGreaterThan(0);
    },
  );
  expect(mock.calls.length).toBeGreaterThan(0);
  expect(
    mock.calls.every((call) => call.ip === publicAddress && call.host === "cascade.example.test"),
  ).toBe(true);
});

test("direct ingestion refuses a connector owned by another tenant before any transport", async () => {
  const [neighbor] = await ctx.testDb.db
    .insert(tenants)
    .values({ slug: "docs-owner-boundary", display_name: "Neighbor" })
    .returning();
  if (!neighbor) throw new Error("missing neighbor");
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: neighbor.id,
      slug: "foreign-docs",
      display_name: "Foreign docs",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning();
  if (!connector) throw new Error("missing connector");
  try {
    const mock = transport(() => new Response("unexpected"));
    await expect(
      ingestDocs(
        {
          tenant_id: ctx.tenantId,
          connector_id: connector.id,
          input: { source_type: "markdown", url: "https://docs.example.test/" },
          fetchImpl: mock.fetchImpl,
        },
        ctx.testDb.db,
      ),
    ).rejects.toThrow("connector_unavailable");
    expect(mock.calls).toHaveLength(0);
  } finally {
    await ctx.testDb.db.delete(connectors).where(eq(connectors.id, connector.id));
    await ctx.testDb.db.delete(tenants).where(eq(tenants.id, neighbor.id));
  }
});

test("an actual unresolved fetch remains registered and cannot persist after suspension", async () => {
  const isolated = await createDocsTestCtx("docs-suspension-boundary", { hosted: true });
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const fetchImpl: typeof fetch = Object.assign(
    async () => {
      enter();
      await stop;
      return new Response("# Reviewed reference\n\nRetain only while the tenant is active.");
    },
    { preconnect: () => {} },
  );
  try {
    await _withEgressLookupForTests(
      async () => [{ address: publicAddress, family: 4 }],
      async () => {
        const work = ingestDocs(
          {
            tenant_id: isolated.tenantId,
            connector_id: isolated.connectorId,
            input: { source_type: "markdown", url: "https://docs.example.test/" },
            fetchImpl,
          },
          isolated.testDb.db,
        );
        await ready;
        expect(tenantWorkSnapshot(isolated.tenantId).in_flight).toBe(1);
        await isolated.testDb.db
          .update(tenants)
          .set({ status: "suspended" })
          .where(eq(tenants.id, isolated.tenantId));
        release();
        await expect(work).rejects.toThrow("tenant_unavailable");
        expect(tenantWorkSnapshot(isolated.tenantId).in_flight).toBe(0);
        expect(
          await isolated.testDb.db
            .select()
            .from(connectorDocuments)
            .where(eq(connectorDocuments.tenant_id, isolated.tenantId)),
        ).toHaveLength(0);
      },
    );
  } finally {
    release();
    await isolated.cleanup();
  }
});

test("hosted fetch failures cannot echo query credentials into logs or propagated errors", async () => {
  const canary = "hosted-document-query-secret-canary";
  const entries: unknown[] = [];
  const info = spyOn(logger, "info").mockImplementation((entry) => {
    entries.push(entry);
  });
  const error = spyOn(logger, "error").mockImplementation((entry) => {
    entries.push(entry);
  });
  const fetchImpl: typeof fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      throw new Error(`upstream rejected ${String(url)} ${canary}`);
    },
    { preconnect: () => {} },
  );
  try {
    await _withEgressLookupForTests(
      async () => [{ address: publicAddress, family: 4 }],
      async () => {
        await expect(ingest("markdown", "https://docs.example.test/", fetchImpl)).rejects.toThrow(
          "document_ingest_failed",
        );
      },
    );
    expect(JSON.stringify(entries)).not.toContain(canary);
    expect(JSON.stringify(entries)).toContain("document_ingest_failed");
    expect(tenantWorkSnapshot(ctx.tenantId).in_flight).toBe(0);
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
});

test("hosted document addresses containing inline credentials never reach transport or persistence", async () => {
  const before = await ctx.testDb.db
    .select()
    .from(connectorDocuments)
    .where(eq(connectorDocuments.tenant_id, ctx.tenantId));
  const mock = transport(() => new Response("# Unexpected"));
  for (const url of [
    "https://user:secret@docs.example.test/",
    "https://docs.example.test/?API_KEY=hosted-inline-secret-canary",
    "https://docs.example.test/?X-Amz-Signature=hosted-inline-secret-canary",
  ]) {
    await expect(ingest("markdown", url, mock.fetchImpl)).rejects.toThrow(
      "Use a public documentation URL",
    );
  }
  expect(mock.calls).toHaveLength(0);
  const after = await ctx.testDb.db
    .select()
    .from(connectorDocuments)
    .where(eq(connectorDocuments.tenant_id, ctx.tenantId));
  expect(after).toEqual(before);
});

test("hosted persistence errors never propagate document text or database parameters", async () => {
  const canary = "hosted-document-persistence-secret-canary";
  const entries: unknown[] = [];
  const error = spyOn(logger, "error").mockImplementation((entry) => {
    entries.push(entry);
  });
  try {
    let failure: unknown;
    try {
      await ingestDocs(
        {
          tenant_id: ctx.tenantId,
          connector_id: ctx.connectorId,
          input: { source_type: "markdown", content: `# Reference\n\n${canary}\u0000invalid` },
        },
        ctx.testDb.db,
      );
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("document_ingest_failed");
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain(canary);
    expect(tenantWorkSnapshot(ctx.tenantId).in_flight).toBe(0);
  } finally {
    error.mockRestore();
  }
});

test("hosted file uploads retain ordinary filenames as source labels", async () => {
  const result = await ingestDocs(
    {
      tenant_id: ctx.tenantId,
      connector_id: ctx.connectorId,
      input: {
        source_type: "file_upload",
        upload: {
          filename: "manual.md",
          mime: "text/markdown",
          buffer: Buffer.from("# Manual\n\nPublic reference content"),
        },
      },
    },
    ctx.testDb.db,
  );
  expect(result.source_uri).toBe("manual.md");
  expect(result.ingested_count).toBeGreaterThan(0);
});

test("malformed hosted addresses never disclose credentials before transport validation", async () => {
  const canary = "hosted-malformed-address-secret-canary";
  const entries: unknown[] = [];
  const info = spyOn(logger, "info").mockImplementation((entry) => {
    entries.push(entry);
  });
  const error = spyOn(logger, "error").mockImplementation((entry) => {
    entries.push(entry);
  });
  const mock = transport(() => {
    throw new Error("unexpected transport");
  });
  try {
    for (const [source, url] of [
      ["markdown", `https://[bad]/?api_key=${canary}`],
      ["markdown", `https://user:${canary}@[`],
      ["postgres", `postgres://user:${canary}@[`],
      ["postgres", `host=invalid password=${canary}`],
    ] as const) {
      await expect(ingest(source, url, mock.fetchImpl)).rejects.toThrow(
        /document_ingest_failed|document_destination_blocked: redacted/,
      );
    }
    expect(mock.calls).toHaveLength(0);
    expect(JSON.stringify(entries)).not.toContain(canary);
    expect(tenantWorkSnapshot(ctx.tenantId).in_flight).toBe(0);
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
});
