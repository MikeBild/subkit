import { expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIpMiddleware, normalizeClientIp, resolveTrustedClientIp } from "./client-ip.ts";
import type { AppEnv } from "./openapi.ts";

const trusted = { trustedHops: 1, trustedProxyIps: ["127.0.0.1", "10.0.0.2"] };

test("direct clients cannot select their IP with forwarding headers", () => {
  expect(resolveTrustedClientIp({ ...trusted, peer: "203.0.113.8", forwardedFor: "1.1.1.1" })).toBe(
    "203.0.113.8",
  );
  expect(resolveTrustedClientIp({ ...trusted, forwardedFor: "1.1.1.1" })).toBe("unknown");
});

test("trusted proxy uses rightmost client entry and ignores forged leftmost entries", () => {
  expect(
    resolveTrustedClientIp({ ...trusted, peer: "127.0.0.1", forwardedFor: "forged, 203.0.113.8" }),
  ).toBe("203.0.113.8");
});

test("multiple proxy hops require every proxy in the trusted suffix", () => {
  expect(
    resolveTrustedClientIp({
      ...trusted,
      trustedHops: 2,
      peer: "127.0.0.1",
      forwardedFor: "203.0.113.8, 10.0.0.2",
    }),
  ).toBe("203.0.113.8");
  expect(
    resolveTrustedClientIp({
      ...trusted,
      trustedHops: 2,
      peer: "127.0.0.1",
      forwardedFor: "203.0.113.8, 10.0.0.3",
    }),
  ).toBe("127.0.0.1");
});

test("missing, short or invalid trusted chains retain peer instead of attacker fallback", () => {
  for (const forwardedFor of [undefined, "", "not-an-ip", "1.1.1.1,,"]) {
    expect(resolveTrustedClientIp({ ...trusted, peer: "127.0.0.1", forwardedFor })).toBe(
      "127.0.0.1",
    );
  }
  expect(
    resolveTrustedClientIp({
      ...trusted,
      trustedHops: 2,
      peer: "127.0.0.1",
      forwardedFor: "1.1.1.1",
    }),
  ).toBe("127.0.0.1");
});

test("zero trust ignores forwarding headers even on allowed peer", () => {
  expect(
    resolveTrustedClientIp({
      ...trusted,
      trustedHops: 0,
      peer: "127.0.0.1",
      forwardedFor: "1.1.1.1",
    }),
  ).toBe("127.0.0.1");
});

test("normalizes IPv4-mapped peer addresses before matching configured proxy IPs", () => {
  expect(normalizeClientIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
  expect(
    resolveTrustedClientIp({ ...trusted, peer: "::ffff:127.0.0.1", forwardedFor: "203.0.113.8" }),
  ).toBe("203.0.113.8");
});

test("request without socket identity cannot spoof client IP using X-Real-IP", async () => {
  const app = new Hono<AppEnv>();
  app.use("*", clientIpMiddleware());
  app.get("/", (context) => context.text(context.get("client_ip") ?? "missing"));
  const response = await app.request("/", {
    headers: { "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" },
  });
  expect(await response.text()).toBe("unknown");
});
