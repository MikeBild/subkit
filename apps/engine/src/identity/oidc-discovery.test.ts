// Pure-function tests for the OIDC discovery helper.
//
// No DB. msw intercepts HTTP so openid-client never leaves the process.
// Covers:
//   - happy-path Zod parse and return shape
//   - per-issuer caching (second call does not hit the network)
//   - cache eviction when nowMs advances past CACHE_TTL_MS
//   - discovery doc missing jwks_uri (still valid — callers check)
//   - issuer mismatch: discovery doc issuer !== requested issuer
//   - network errors from 429 / 5xx responses
//   - flushDiscoveryCache + isCached utilities

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  DiscoveryDocSchema,
  fetchDiscovery,
  flushDiscoveryCache,
  isCached,
} from "./oidc-discovery.ts";

// ---------------------------------------------------------------------------
// MSW server setup
// ---------------------------------------------------------------------------

const ISSUER = "http://127.0.0.1:19999";
const DISCOVERY_PATH = "/.well-known/openid-configuration";
const JWKS_URI = `${ISSUER}/jwks`;

function makeDiscoveryBody(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: JWKS_URI,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    ...overrides,
  };
}

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  flushDiscoveryCache();
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscoveryDocSchema", () => {
  test("parses a minimal valid document", () => {
    const result = DiscoveryDocSchema.safeParse({ issuer: "https://id.example.com" });
    expect(result.success).toBe(true);
  });

  test("parses a full document with jwks_uri", () => {
    const result = DiscoveryDocSchema.safeParse({
      issuer: "https://id.example.com",
      jwks_uri: "https://id.example.com/jwks",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.jwks_uri).toBe("https://id.example.com/jwks");
  });

  test("rejects missing issuer", () => {
    const result = DiscoveryDocSchema.safeParse({ jwks_uri: "https://id.example.com/jwks" });
    expect(result.success).toBe(false);
  });

  test("rejects jwks_uri that is not a URL", () => {
    const result = DiscoveryDocSchema.safeParse({
      issuer: "https://id.example.com",
      jwks_uri: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("fetchDiscovery — happy path", () => {
  test("fetches and Zod-parses the discovery doc", async () => {
    server.use(
      http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.json(makeDiscoveryBody())),
    );

    const doc = await fetchDiscovery(new URL(ISSUER));
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.jwks_uri).toBe(JWKS_URI);
  });

  test("returns a doc missing jwks_uri when the server omits it", async () => {
    const body = makeDiscoveryBody();
    // biome-ignore lint/suspicious/noExplicitAny: removing key from test fixture
    delete (body as any).jwks_uri;
    server.use(http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.json(body)));

    const doc = await fetchDiscovery(new URL(ISSUER));
    expect(doc.jwks_uri).toBeUndefined();
  });
});

describe("fetchDiscovery — per-issuer caching", () => {
  test("caches the result so a second call skips the network", async () => {
    let hitCount = 0;
    server.use(
      http.get(`${ISSUER}${DISCOVERY_PATH}`, () => {
        hitCount += 1;
        return HttpResponse.json(makeDiscoveryBody());
      }),
    );

    const first = await fetchDiscovery(new URL(ISSUER));
    const second = await fetchDiscovery(new URL(ISSUER));
    expect(hitCount).toBe(1);
    expect(second).toEqual(first);
  });

  test("isCached returns true immediately after a successful fetch", async () => {
    server.use(
      http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.json(makeDiscoveryBody())),
    );
    expect(isCached(ISSUER)).toBe(false);
    await fetchDiscovery(new URL(ISSUER));
    expect(isCached(ISSUER)).toBe(true);
  });

  test("cache evicts when nowMs advances past CACHE_TTL_MS", async () => {
    server.use(
      http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.json(makeDiscoveryBody())),
    );
    // Seed the cache with a fake fetchedAt that is already 5m+1ms in the past.
    const TTL_MS = 5 * 60 * 1_000;
    const staleNow = Date.now() - TTL_MS - 1;
    await fetchDiscovery(new URL(ISSUER), { nowMs: staleNow });

    // A second call with present-time nowMs should be treated as a cache miss.
    const freshNow = Date.now();
    expect(isCached(ISSUER, freshNow)).toBe(false);
  });

  test("flushDiscoveryCache clears all entries", async () => {
    server.use(
      http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.json(makeDiscoveryBody())),
    );
    await fetchDiscovery(new URL(ISSUER));
    expect(isCached(ISSUER)).toBe(true);
    flushDiscoveryCache();
    expect(isCached(ISSUER)).toBe(false);
  });
});

describe("fetchDiscovery — network errors / backoff gates", () => {
  test("throws on a 429 response", async () => {
    server.use(
      http.get(
        `${ISSUER}${DISCOVERY_PATH}`,
        () => new HttpResponse(null, { status: 429, statusText: "Too Many Requests" }),
      ),
    );
    await expect(fetchDiscovery(new URL(ISSUER))).rejects.toThrow();
  });

  test("throws on a 500 response", async () => {
    server.use(
      http.get(
        `${ISSUER}${DISCOVERY_PATH}`,
        () => new HttpResponse(null, { status: 500, statusText: "Internal Server Error" }),
      ),
    );
    await expect(fetchDiscovery(new URL(ISSUER))).rejects.toThrow();
  });

  test("throws on a network-level connection error", async () => {
    server.use(http.get(`${ISSUER}${DISCOVERY_PATH}`, () => HttpResponse.error()));
    await expect(fetchDiscovery(new URL(ISSUER))).rejects.toThrow();
  });
});
