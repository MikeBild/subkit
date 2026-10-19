import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { probeAllSelfDescriptionLinks } from "../../connectors/discovery/self-description-probe.ts";
import { withDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { _withEgressLookupForTests } from "../../connectors/egress-guard.ts";
import { authIdentities, connectors, tenants } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { analyzeScrapeTargetTool } from "../tools/analyze-scrape-target.ts";
import { fetchConnectorSelfDescriptionTool } from "../tools/fetch-connector-self-description.ts";
import type { ToolContext } from "../tools/index.ts";

let server: HttpTestServer;
let ctx: ToolContext;
let connectorId: string;
beforeAll(async () => {
  server = await createHttpTestServer("hosted-discovery-egress");
  await configureHostedPolicyForTests(server.db, server.testDb.url);
  const [identity] = await server.db
    .insert(authIdentities)
    .values({
      issuer_url: "https://identity.example.test",
      subject: "discovery-owner",
      email: "discovery@example.test",
    })
    .returning();
  if (!identity) throw new Error("identity fixture missing");
  const [tenant] = await server.db
    .insert(tenants)
    .values({
      slug: "hosted-discovery",
      display_name: "Hosted Discovery",
      origin: "self_service",
      owner_identity_id: identity.id,
    })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  const [connector] = await server.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug: "hosted-discovery",
      display_name: "Hosted Discovery",
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: "https://docs.example.test/",
      self_description: {
        links: [
          {
            kind: "llms_txt",
            url: "https://docs.example.test/llms.txt",
            source: "manual",
            discovered_at: new Date(getTestNow()).toISOString(),
          },
        ],
      },
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  connectorId = connector.id;
  ctx = {
    db: server.db,
    tenant_id: tenant.id,
    connector_id: connector.id,
  } as unknown as ToolContext;
});
afterAll(async () => {
  if (server) await server.cleanup();
});
const publicAddress = "93.184.216.34";
function transport(respond: (url: URL) => Response) {
  const calls: Array<{ ip: string; host: string | null; path: string }> = [];
  const fetchImpl = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({
        ip: url.hostname,
        host: new Headers(init?.headers).get("host"),
        path: url.pathname,
      });
      return respond(url);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return { calls, fetchImpl };
}

test("background self-description probing pins every actual request and refuses private redirects", async () => {
  const mock = transport(
    () => new Response(null, { status: 307, headers: { location: "http://127.0.0.1/private" } }),
  );
  await _withEgressLookupForTests(
    async () => [{ address: publicAddress, family: 4 }],
    async () => {
      expect(
        await probeAllSelfDescriptionLinks("https://probe.example.test/", {
          tenant_id: ctx.tenant_id,
          exec: server.db,
          fetchImpl: mock.fetchImpl,
          headers: { authorization: "Bearer synthetic" },
        }),
      ).toEqual([]);
    },
  );
  expect(mock.calls.length).toBeGreaterThan(0);
  expect(
    mock.calls.every((call) => call.ip === publicAddress && call.host === "probe.example.test"),
  ).toBe(true);
  expect(mock.calls.some((call) => call.path === "/private")).toBe(false);
});

test("conversation self-description fetching preserves pinning and rejects DNS rebinding", async () => {
  const mock = transport(() => new Response("# Synthetic docs"));
  const result = await _withEgressLookupForTests(
    async () => [{ address: publicAddress, family: 4 }],
    () =>
      withDriverFetch(mock.fetchImpl, () =>
        fetchConnectorSelfDescriptionTool.execute(ctx, { kind: "llms" }),
      ),
  );
  expect(result.ok).toBe(true);
  expect(mock.calls).toEqual([{ ip: publicAddress, host: "docs.example.test", path: "/llms.txt" }]);
  await server.db
    .update(connectors)
    .set({
      self_description: {
        links: [
          {
            kind: "llms_txt",
            url: "https://rebound.example.test/llms.txt",
            source: "manual",
            discovered_at: new Date(getTestNow()).toISOString(),
          },
        ],
      },
    })
    .where(eq(connectors.id, connectorId));
  const blocked = transport(() => {
    throw new Error("must not dispatch");
  });
  const denied = await _withEgressLookupForTests(
    async () => [{ address: "127.0.0.1", family: 4 }],
    () =>
      withDriverFetch(blocked.fetchImpl, () =>
        fetchConnectorSelfDescriptionTool.execute(ctx, { kind: "llms" }),
      ),
  );
  expect(denied.ok).toBe(false);
  expect(blocked.calls).toHaveLength(0);
});

test("scraper analysis returns red when a sitemap redirects to a private destination", async () => {
  const mock = transport((url) =>
    url.pathname === "/robots.txt"
      ? new Response("User-agent: *\nAllow: /\n")
      : new Response(null, { status: 307, headers: { location: "http://127.0.0.1/private" } }),
  );
  const result = await _withEgressLookupForTests(
    async () => [{ address: publicAddress, family: 4 }],
    () =>
      withDriverFetch(mock.fetchImpl, () =>
        analyzeScrapeTargetTool.execute(ctx, {
          target_url: "https://scrape.example.test/docs",
          sitemap_url: "https://scrape.example.test/sitemap.xml",
        }),
      ),
  );
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ verdict: "red" });
  expect(
    mock.calls.every((call) => call.ip === publicAddress && call.host === "scrape.example.test"),
  ).toBe(true);
  expect(mock.calls.some((call) => call.path === "/private")).toBe(false);
});
