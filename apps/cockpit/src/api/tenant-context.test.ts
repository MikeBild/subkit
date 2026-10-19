import { afterEach, expect, test } from "bun:test";
import { readSseStream } from "../lib/sse-stream";
import { apiRequest, apiText } from "./client";
import {
  acceptTenantContext,
  onTenantContextChanged,
  tenantContentHref,
  tenantContextHeaders,
} from "./tenant-context";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pinnedTenant() {
  const id = tenantContextHeaders()["x-subkit-tenant"] ?? "tenant-a";
  expect(acceptTenantContext(id)).toBe(true);
  return id;
}

test("a tab cannot replace its tenant context after bootstrap", () => {
  const id = pinnedTenant();
  expect(acceptTenantContext(`${id}-other`)).toBe(false);
  expect(tenantContextHeaders()).toEqual({ "x-subkit-tenant": id });
  expect(tenantContentHref("/v1/files/source/content?download=1")).toBe(
    `/v1/files/source/content?download=1&tenant_context=${encodeURIComponent(id)}`,
  );
});

test("JSON, text and event streams carry the pinned tab context", async () => {
  const id = pinnedTenant();
  const requests: Headers[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await apiRequest("/v1/files");
  await apiText("/v1/files/source/content");
  await readSseStream("/v1/events", {
    signal: new AbortController().signal,
    lastEventId: null,
    onFrame() {},
  });
  expect(requests).toHaveLength(3);
  for (const headers of requests) expect(headers.get("x-subkit-tenant")).toBe(id);
});

test("repeated tenant conflicts invalidate the visible session once", async () => {
  let notices = 0;
  const stop = onTenantContextChanged(() => {
    notices += 1;
  });
  globalThis.fetch = (async () =>
    Response.json({ code: "tenant_context_changed" }, { status: 409 })) as unknown as typeof fetch;
  try {
    await expect(apiRequest("/v1/files")).rejects.toThrow();
    await expect(
      readSseStream("/v1/events", {
        signal: new AbortController().signal,
        lastEventId: null,
        onFrame() {},
      }),
    ).rejects.toThrow();
    expect(notices).toBe(1);
  } finally {
    stop();
  }
});
