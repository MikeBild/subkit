import { describe, expect, test } from "bun:test";
import { fetchSetupStatus } from "../setup-banner.ts";

type StubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
function asFetch(stub: StubFetch): typeof globalThis.fetch {
  return stub as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchSetupStatus", () => {
  test("normalizes a `warn` payload into the banner shape", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const stubFetch = asFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        overall_status: "warn",
        summary_counts: { blockers: 0, warnings: 2 },
      });
    });
    const result = await fetchSetupStatus("http://localhost:3000", "token-xyz", {
      fetch: stubFetch,
    });
    expect(result).toEqual({
      overall_status: "warn",
      warning_count: 2,
      error_count: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:3000/v1/diagnostics/setup");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization ?? headers?.Authorization).toBe("Bearer token-xyz");
  });

  test("normalizes a `blocked` payload (counts taken from summary_counts)", async () => {
    const stubFetch = asFetch(async () =>
      jsonResponse({
        overall_status: "blocked",
        summary_counts: { blockers: 3, warnings: 1 },
      }),
    );
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result).toEqual({
      overall_status: "blocked",
      warning_count: 1,
      error_count: 3,
    });
  });

  test("trims a trailing slash on the engine URL", async () => {
    const seen: string[] = [];
    const stubFetch = asFetch(async (input) => {
      seen.push(String(input));
      return jsonResponse({ overall_status: "ok", summary_counts: { blockers: 0, warnings: 0 } });
    });
    await fetchSetupStatus("http://localhost:3000/", "k", { fetch: stubFetch });
    expect(seen[0]).toBe("http://localhost:3000/v1/diagnostics/setup");
  });

  test("returns fail-open snapshot on a 5xx response", async () => {
    const stubFetch = asFetch(async () => new Response("boom", { status: 503 }));
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result).toEqual({
      overall_status: "ok",
      warning_count: 0,
      error_count: 0,
    });
  });

  test("returns fail-open snapshot on a 4xx response", async () => {
    const stubFetch = asFetch(async () => new Response("nope", { status: 401 }));
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result.overall_status).toBe("ok");
  });

  test("returns fail-open snapshot when the body is malformed JSON", async () => {
    const stubFetch = asFetch(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result.overall_status).toBe("ok");
  });

  test("returns fail-open snapshot on a network throw", async () => {
    const stubFetch = asFetch(async () => {
      throw new TypeError("ECONNREFUSED");
    });
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result).toEqual({
      overall_status: "ok",
      warning_count: 0,
      error_count: 0,
    });
  });

  test("returns fail-open snapshot when AbortSignal.timeout fires", async () => {
    const stubFetch = asFetch(async () => {
      throw new DOMException("aborted", "TimeoutError");
    });
    const result = await fetchSetupStatus("http://localhost:3000", "k", {
      fetch: stubFetch,
      timeoutMs: 50,
    });
    expect(result.overall_status).toBe("ok");
  });

  test("treats unknown overall_status values as ok (defensive default)", async () => {
    const stubFetch = asFetch(async () =>
      jsonResponse({
        overall_status: "definitely-not-a-status",
        summary_counts: { blockers: 9, warnings: 9 },
      }),
    );
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result.overall_status).toBe("ok");
    expect(result.warning_count).toBe(9);
    expect(result.error_count).toBe(9);
  });

  test("clamps non-numeric counts to zero", async () => {
    const stubFetch = asFetch(async () =>
      jsonResponse({
        overall_status: "warn",
        summary_counts: { blockers: "lots", warnings: null },
      }),
    );
    const result = await fetchSetupStatus("http://localhost:3000", "k", { fetch: stubFetch });
    expect(result).toEqual({
      overall_status: "warn",
      warning_count: 0,
      error_count: 0,
    });
  });
});
