import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { logger } from "../logging/logger.ts";
import {
  __resetProxyUntrustedWarning,
  clientIpMiddleware,
  detectUntrustedProxy,
  normalizeClientIp,
  resolveTrustedClientIp,
} from "./client-ip.ts";
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

function proxiedApp() {
  const app = new Hono<AppEnv>();
  app.use("*", clientIpMiddleware());
  app.get("/", (context) => context.text(context.get("client_ip") ?? "missing"));
  return app;
}

function proxiedRequest(app: Hono<AppEnv>, remoteAddress: string, forwardedFor?: string) {
  return app.request(
    "/",
    { headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} },
    { incoming: { socket: { remoteAddress } } },
  );
}

function captureWarnings() {
  const entries: Array<Record<string, unknown>> = [];
  const spy = spyOn(logger, "warn").mockImplementation((entry) => {
    entries.push(entry);
  });
  return {
    proxyWarnings: () => entries.filter((entry) => entry.action === "client_ip.proxy_untrusted"),
    restore: () => spy.mockRestore(),
  };
}

test("untrusted reverse proxy is reported once per process without header values", async () => {
  __resetProxyUntrustedWarning();
  const capture = captureWarnings();
  try {
    const app = proxiedApp();
    const first = await proxiedRequest(app, "127.0.0.1", "203.0.113.8");
    expect(await first.text()).toBe("127.0.0.1");
    await proxiedRequest(app, "::1", "203.0.113.9");
    await proxiedRequest(app, "10.0.0.5", "203.0.113.10");
    const warnings = capture.proxyWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ module: "http", peer_kind: "loopback" });
    expect(JSON.stringify(warnings[0])).not.toContain("203.0.113");
  } finally {
    capture.restore();
    __resetProxyUntrustedWarning();
  }
});

test("direct public clients and proxied requests without forwarding headers stay silent", async () => {
  __resetProxyUntrustedWarning();
  const capture = captureWarnings();
  try {
    const app = proxiedApp();
    const direct = await proxiedRequest(app, "203.0.113.8", "198.51.100.1");
    expect(await direct.text()).toBe("203.0.113.8");
    await proxiedRequest(app, "127.0.0.1");
    expect(capture.proxyWarnings()).toHaveLength(0);
  } finally {
    capture.restore();
    __resetProxyUntrustedWarning();
  }
});

test("untrusted proxy detection classifies peers and respects configured trust", () => {
  const loopback = { peer: "127.0.0.1", forwardedFor: "203.0.113.8" };
  expect(detectUntrustedProxy({ ...loopback, trustedHops: 0, trustedProxyIps: [] })).toBe(
    "loopback",
  );
  expect(
    detectUntrustedProxy({ ...loopback, trustedHops: 0, trustedProxyIps: ["127.0.0.1"] }),
  ).toBe("loopback");
  expect(detectUntrustedProxy({ ...loopback, trustedHops: 1, trustedProxyIps: ["10.0.0.2"] })).toBe(
    "loopback",
  );
  expect(
    detectUntrustedProxy({
      peer: "192.168.1.4",
      forwardedFor: "203.0.113.8",
      trustedHops: 0,
      trustedProxyIps: [],
    }),
  ).toBe("private");
  expect(
    detectUntrustedProxy({ ...loopback, trustedHops: 1, trustedProxyIps: ["127.0.0.1", "::1"] }),
  ).toBeUndefined();
});

test("forwarding headers are never trusted without configuration and honored with one trusted hop", () => {
  const loopback = { peer: "127.0.0.1", forwardedFor: "203.0.113.8" };
  expect(resolveTrustedClientIp({ ...loopback, trustedHops: 0, trustedProxyIps: [] })).toBe(
    "127.0.0.1",
  );
  expect(
    resolveTrustedClientIp({ ...loopback, trustedHops: 0, trustedProxyIps: ["127.0.0.1"] }),
  ).toBe("127.0.0.1");
  expect(
    resolveTrustedClientIp({ ...loopback, trustedHops: 1, trustedProxyIps: ["127.0.0.1", "::1"] }),
  ).toBe("203.0.113.8");
});
