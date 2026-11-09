import { afterEach, describe, expect, mock, test } from "bun:test";
import { apiCall, apiMultipart, resolveApiPath } from "./call";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
  }) as unknown as typeof fetch;
  return calls;
}

describe("resolveApiPath", () => {
  test("fills and encodes path parameters", () => {
    expect(
      resolveApiPath(
        "/v1/skills/{id}/history/{audit_entry_id}",
        { id: "a b", audit_entry_id: 7 },
        undefined,
      ),
    ).toBe("/v1/skills/a%20b/history/7");
  });

  test("skips empty query values and repeats arrays", () => {
    expect(
      resolveApiPath("/v1/workflows", undefined, {
        limit: 20,
        category: undefined,
        q: null,
        tag: ["a", "b"],
        archived: false,
      }),
    ).toBe("/v1/workflows?limit=20&tag=a&tag=b&archived=false");
  });

  test("refuses a missing path parameter", () => {
    expect(() => resolveApiPath("/v1/skills/{id}", {}, undefined)).toThrow(
      "missing path parameter id for /v1/skills/{id}",
    );
  });
});

describe("apiCall", () => {
  test("multipart keeps file bytes, metadata, session credentials and cancellation", async () => {
    const calls = capture(200, { archive_file_id: "archive-1" });
    const controller = new AbortController();
    const archive = new File(["archive bytes"], "fixture.zip", { type: "application/zip" });
    await apiMultipart("/v1/packages/import/preview", {
      body: { archive },
      signal: controller.signal,
      headers: { "x-custom": "preserved" },
    });
    const init = calls[0]?.init;
    expect(init?.credentials).toBe("same-origin");
    expect(init?.signal).toBe(controller.signal);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-subkit-client")).toBe("cockpit");
    expect(headers.get("x-custom")).toBe("preserved");
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("multipart request body is missing");
    const file = body.get("archive") as File;
    expect(file.name).toBe("fixture.zip");
    expect(await file.text()).toBe("archive bytes");
  });

  test("multipart encodes optional metadata without serializing absent fields", async () => {
    const calls = capture(201, { id: "knowledge-1" });
    await apiMultipart("/v1/knowledge-sources", { body: { metadata: '{"name":"example"}' } });
    const form = calls[0]?.init.body as FormData;
    expect(form.get("metadata")).toBe('{"name":"example"}');
    expect(form.has("file")).toBe(false);
  });
  test("sends method, resolved path and JSON body and returns the parsed body", async () => {
    const calls = capture(200, { id: "s-1" });
    const result = await apiCall("patch", "/v1/skills/{id}", {
      path: { id: "s-1" },
      body: { title: "Renamed" },
    });
    expect(result).toEqual({ id: "s-1" } as never);
    expect(calls[0]?.url.endsWith("/v1/skills/s-1")).toBe(true);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ title: "Renamed" }));
  });

  test("passes extra headers to the request", async () => {
    const calls = capture(200, { id: "s-1" });
    await apiCall("get", "/v1/skills/{id}", {
      path: { id: "s-1" },
      headers: { "x-subkit-environment": "prod" },
    });
    expect(new Headers(calls[0]?.init.headers).get("x-subkit-environment")).toBe("prod");
  });

  test("answers null for a 204", async () => {
    capture(204, null);
    expect(await apiCall("delete", "/v1/skills/{id}", { path: { id: "s-1" } })).toBeNull();
  });

  test("throws the cockpit failure for a non-ok answer", async () => {
    capture(404, { code: "not_found", message: "skill not found" });
    await expect(
      apiCall("get", "/v1/skills/{id}", { path: { id: "missing" } }),
    ).rejects.toBeDefined();
  });
});
