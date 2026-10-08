import { afterEach, expect, test } from "bun:test";
import { ApiError, apiRequest, onSessionExpired, retryQuery } from "./client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("an expired session on any request tells the session gate once per request", async () => {
  let notices = 0;
  const stop = onSessionExpired(() => {
    notices += 1;
  });
  answer(401, { code: "unauthorized", message: "missing_or_invalid_credentials" });
  await expect(apiRequest("/v1/workflows/abc")).rejects.toBeInstanceOf(ApiError);
  expect(notices).toBe(1);
  stop();
});

test("a refusal that is not about the session never signs the reader out", async () => {
  let notices = 0;
  const stop = onSessionExpired(() => {
    notices += 1;
  });
  answer(403, { code: "forbidden" });
  await expect(apiRequest("/v1/settings")).rejects.toBeInstanceOf(ApiError);
  answer(401, { code: "invalid_grant" });
  await expect(apiRequest("/v1/connectors/x/test")).rejects.toBeInstanceOf(ApiError);
  answer(500, { code: "internal" });
  await expect(apiRequest("/v1/workflows")).rejects.toBeInstanceOf(ApiError);
  expect(notices).toBe(0);
  stop();
});

test("a query whose session expired is not retried", () => {
  expect(retryQuery(0, new ApiError(401, { code: "unauthorized" }, null))).toBe(false);
});

test("a refusal the reader cannot outwait is not retried", () => {
  for (const status of [400, 403, 404, 409, 422]) {
    expect(retryQuery(0, new ApiError(status, { code: "refused" }, null))).toBe(false);
  }
});

test("a server failure, timeout, rate limit or lost connection is retried up to three times", () => {
  for (const status of [500, 503, 408, 429]) {
    expect(retryQuery(0, new ApiError(status, { code: "x" }, null))).toBe(true);
  }
  expect(retryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  expect(retryQuery(3, new ApiError(500, { code: "internal" }, null))).toBe(false);
});
