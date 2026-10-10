import { describe, expect, test } from "bun:test";
import {
  IntakeLiveUsageError,
  isBodyFreeIntakeSummary,
  openApiHasIntakeContract,
  parseIntakeLiveArgs,
  runIntakeLiveSmoke,
} from "../verify-intake-live.ts";

const tenantId = "00000000-0000-4000-8000-000000000001";
const env = { SK_INTAKE_TEST_KEY: "restricted-test-key" };

function writeArgs() {
  return parseIntakeLiveArgs(
    [
      "--engine-url",
      "https://test.example",
      "--allow-writes",
      "--run-id",
      "intake-smoke-run",
      "--test-tenant-id",
      tenantId,
      "--json",
      "/tmp/intake-proof.json",
    ],
    env,
  );
}

function response(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function zipResponse() {
  return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), {
    headers: { "content-type": "application/zip" },
  });
}

function mockFetcher(
  opts: {
    tenant?: string;
    failAt?: string;
    badReady?: boolean;
    duplicate?: boolean;
    unrelatedHit?: boolean;
    leakedClip?: boolean;
  } = {},
) {
  const posts: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  const sourceId = "source-1";
  const itemId = "item-1";
  const proposalId = "proposal-1";
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    redirects.push(init?.redirect);
    if ((init?.method ?? "GET") === "POST") posts.push(url.pathname);
    if (opts.failAt === key) throw new Error("simulated network interruption");
    if (url.pathname === "/health") return response({ status: "ok", service: "subkit" });
    if (url.pathname === "/ready")
      return response(
        opts.badReady
          ? { status: "not-ready" }
          : { status: "ready", checks: { database: "pass", lifecycle: "pass" } },
      );
    if (url.pathname === "/openapi.json")
      return response({
        paths: {
          "/v1/categories": {},
          "/v1/intake/default-category": {},
          "/v1/intake/items": {},
          "/v1/intake/proposals": {},
          "/v1/intake/proposals/{id}/confirm": {},
          "/v1/agent/briefing": {},
        },
      });
    if (url.pathname === "/llms-full.txt")
      return new Response(
        "collect → review in chat → confirm → knowledge. MCP clients start a review through conversation_start.",
        { status: 200 },
      );
    if (url.pathname === "/install/clipper.zip") return zipResponse();
    if (url.pathname === "/v1/agent/briefing") {
      if (
        url.searchParams.get("domains") === "intake-smoke" &&
        posts.includes("/v1/intake/proposals/source")
      )
        return response({
          markdown: "",
          intake: { collected: 0, reviewing: 0, proposals: 0 },
          knowledge_sources: ["actual-source-slug"],
        });
      return response({
        markdown: "",
        intake: { collected: 0, reviewing: 0, proposals: 0 },
        knowledge_sources: ["actual-source-slug"],
      });
    }
    if (url.pathname === "/v1/status")
      return response({ user: { kind: "user" }, tenant: { id: opts.tenant ?? tenantId } });
    if (url.pathname === "/v1/intake/items" && init?.method === "POST")
      return response({ id: itemId, category: JSON.parse(String(init.body)).category }, 201);
    if (url.pathname === "/v1/knowledge-sources/search") {
      const confirmed = posts.includes(`/v1/intake/proposals/${proposalId}/confirm`);
      return response({
        hits: confirmed
          ? [{ knowledge_source_id: sourceId }]
          : opts.leakedClip
            ? [{ source_name: "Smoke clip intake-smoke-run" }]
            : opts.unrelatedHit
              ? [
                  {
                    source_name: "Unrelated confirmed material",
                    snippet: "intake smoke earlier run",
                  },
                ]
              : [],
      });
    }
    if (url.pathname === "/v1/intake/proposals" && init?.method === "POST")
      return response(
        {
          id: proposalId,
          current_revision: 1,
          revision: {
            digest: "digest",
            title: "Intake smoke intake-smoke-run",
            body: "intake smoke intake-smoke-run confirmed knowledge fixture.",
            target: {
              name: "Intake smoke intake-smoke-run",
              category: "intake-smoke",
              tags: ["domain:intake-smoke"],
            },
          },
        },
        201,
      );
    if (url.pathname === `/v1/intake/proposals/${proposalId}` && (init?.method ?? "GET") === "GET")
      return response({
        current_revision: 1,
        revision: {
          digest: "digest",
          title: "Intake smoke intake-smoke-run",
          body: "intake smoke intake-smoke-run confirmed knowledge fixture.",
          target: {
            name: "Intake smoke intake-smoke-run",
            category: "intake-smoke",
            tags: ["domain:intake-smoke"],
          },
        },
      });
    if (url.pathname === `/v1/intake/proposals/${proposalId}/confirm`)
      return response({ status: "confirmed", confirmed_knowledge_source_id: sourceId });
    if (url.pathname === `/v1/intake/items/${itemId}`)
      return response({
        state: "admitted",
        admitted_knowledge_source_id: sourceId,
        original_snapshot: { source_url: "https://example.invalid/intake-smoke/intake-smoke-run" },
      });
    if (url.pathname === `/v1/knowledge-sources/${sourceId}`)
      return response({ slug: "actual-source-slug" });
    if (url.pathname === "/v1/knowledge-sources") {
      const items = [{ id: sourceId, name: "Intake smoke intake-smoke-run" }];
      if (opts.duplicate)
        items.push({ id: "duplicate-source", name: "Intake smoke intake-smoke-run" });
      return response({ items, total: items.length });
    }
    return response({ error: key }, 404);
  };
  return { fetcher: fetcher as typeof fetch, posts, redirects };
}

describe("verify intake production smoke arguments", () => {
  test("keeps write mode unavailable without every explicit opt-in guard", () => {
    expect(() => parseIntakeLiveArgs(["--engine-url", "https://test.example"], env)).not.toThrow();
    expect(() =>
      parseIntakeLiveArgs(["--engine-url", "https://test.example", "--allow-writes"], env),
    ).toThrow(IntakeLiveUsageError);
    expect(() => parseIntakeLiveArgs(["--engine-url", "ftp://test.example"], env)).toThrow(
      IntakeLiveUsageError,
    );
    expect(() => parseIntakeLiveArgs(["--engine-url", "https://key@test.example"], env)).toThrow(
      IntakeLiveUsageError,
    );
    expect(() =>
      parseIntakeLiveArgs(["--engine-url", "https://test.example", "--api-key", "leak"], env),
    ).toThrow(IntakeLiveUsageError);
  });

  test("requires a selected tenant and writes a structured report only in write mode", () => {
    expect(writeArgs()).toMatchObject({
      engineUrl: "https://test.example",
      allowWrites: true,
      runId: "intake-smoke-run",
      testTenantId: tenantId,
      jsonPath: "/tmp/intake-proof.json",
    });
  });
});

describe("verify intake production smoke contract checks", () => {
  test("requires every public route needed for the collection-to-knowledge flow", () => {
    expect(
      openApiHasIntakeContract({
        paths: {
          "/v1/categories": {},
          "/v1/intake/default-category": {},
          "/v1/intake/items": {},
          "/v1/intake/proposals": {},
          "/v1/intake/proposals/{id}/confirm": {},
          "/v1/agent/briefing": {},
        },
      }),
    ).toBe(true);
    expect(openApiHasIntakeContract({ paths: { "/v1/intake/items": {} } })).toBe(false);
    expect(isBodyFreeIntakeSummary({ collected: 1, reviewing: 0, proposals: 0 })).toBe(true);
    expect(isBodyFreeIntakeSummary({ collected: 1, body: "clip", reviewing: 0 })).toBe(false);
  });

  test("runs the injected public write sequence without redirects and reports retained resources", async () => {
    const mock = mockFetcher();
    const report = await runIntakeLiveSmoke(writeArgs(), mock.fetcher);
    expect(report.summary.failed).toBe(0);
    expect(mock.posts).toEqual([
      "/v1/intake/items",
      "/v1/intake/proposals",
      "/v1/intake/proposals/proposal-1/confirm",
      "/v1/intake/proposals/proposal-1/confirm",
    ]);
    expect(mock.redirects.filter((redirect) => redirect === "error").length).toBeGreaterThan(0);
    expect(report.retained_resource_ids).toEqual(["item-1", "proposal-1", "source-1"]);
    expect(report.cleanup).toMatchObject({
      attempted: false,
      status: "not_attempted",
      resource_ids: ["item-1", "proposal-1", "source-1"],
    });
  });

  test("ignores unrelated semantic matches but rejects the unconfirmed clip", async () => {
    const unrelated = await runIntakeLiveSmoke(
      writeArgs(),
      mockFetcher({ unrelatedHit: true }).fetcher,
    );
    expect(
      unrelated.checks.find((check) => check.id === "write.preconfirm_exclusion")?.status,
    ).toBe("PASS");
    const leaked = await runIntakeLiveSmoke(writeArgs(), mockFetcher({ leakedClip: true }).fetcher);
    expect(leaked.checks.find((check) => check.id === "write.preconfirm_exclusion")?.status).toBe(
      "FAIL",
    );
  });

  test("detects duplicate sources even when repeat confirmation returns the original ID", async () => {
    const mock = mockFetcher({ duplicate: true });
    const report = await runIntakeLiveSmoke(writeArgs(), mock.fetcher);
    expect(report.checks.find((check) => check.id === "write.confirm_idempotent")?.status).toBe(
      "PASS",
    );
    expect(report.checks.find((check) => check.id === "write.single_admission")?.status).toBe(
      "FAIL",
    );
  });

  test("blocks all writes when compatibility checks fail", async () => {
    const mock = mockFetcher({ badReady: true });
    const report = await runIntakeLiveSmoke(writeArgs(), mock.fetcher);
    expect(mock.posts).toEqual([]);
    expect(report.checks.find((check) => check.id === "write.flow")?.status).toBe("SKIP");
  });

  test("fails closed on mismatched identity before a POST", async () => {
    const mock = mockFetcher({ tenant: "00000000-0000-4000-8000-000000000002" });
    const report = await runIntakeLiveSmoke(writeArgs(), mock.fetcher);
    expect(mock.posts).toEqual([]);
    expect(report.checks.find((check) => check.id === "write.identity")?.status).toBe("FAIL");
  });

  test("retains identifiers when the network fails after collection", async () => {
    const mock = mockFetcher({ failAt: "GET /v1/knowledge-sources/search" });
    const report = await runIntakeLiveSmoke(writeArgs(), mock.fetcher);
    expect(report.retained_resource_ids).toEqual(["item-1"]);
    expect(report.summary.failed).toBeGreaterThan(0);
  });
});
