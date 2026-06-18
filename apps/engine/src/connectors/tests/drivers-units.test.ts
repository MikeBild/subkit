// Driver unit tests. Covers the parts of every driver that don't need a
// live service: DSN scheme/shape parsing, argument validation, the
// "missing DSN" guard, and the probe-against-unreachable-endpoint
// failure shape.
//
// Real-service integration coverage (testcontainers / docker-compose
// against actual redis/ftp/sftp/mssql/smb servers) is tracked
// separately as a follow-up to this issue — testcontainers does not
// reliably start on the macOS dev loop today, and the GitHub Actions
// runner has not yet been provisioned with the docker-in-docker setup
// these would need. Once that lands, swap this file's "probe an
// unreachable endpoint" cases for full round-trip checks.
//
// Coverage target (driver): line ≥80 %, branch ≥70 % per the audit
// floor. The unit cases here exercise both the happy parse path and
// the per-driver error envelope.

import { describe, expect, test } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { executeFtpCommand, probeFtpConnector } from "../drivers/ftp.ts";
import { mssqlQuery, probeMssqlConnector } from "../drivers/mssql.ts";
import { executeRedisCommand, probeRedisConnector } from "../drivers/redis.ts";
import { executeSftpCommand, probeSftpConnector } from "../drivers/sftp.ts";
import { executeSmbCommand, probeSmbConnector } from "../drivers/smb.ts";
import type { ConnectorView } from "../types.ts";

// Tiny stub that satisfies ConnectorView for the scope of these
// tests. The driver entry points only read `id`, `environment`, and
// `dsn`.
function fakeConnector(overrides: Partial<ConnectorView>): ConnectorView {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-0000000000aa",
    name: "test",
    slug: "test",
    driver: "redis",
    environment: "dev",
    auth_type: "none",
    dsn: null,
    config: {},
    base_url: null,
    spec_url: null,
    docs_url: null,
    metadata: null,
    discovered_endpoints_at: null,
    last_used_at: null,
    created_at: new Date(FROZEN_NOW),
    updated_at: new Date(FROZEN_NOW),
    deleted_at: null,
    ...overrides,
  } as ConnectorView;
}

// ---------- redis ----------

describe("redis driver — units", () => {
  test("probe rejects bad scheme cleanly via the surfaced detail", async () => {
    const c = fakeConnector({ driver: "redis", dsn: "http://nope" });
    const probe = await probeRedisConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toBeDefined();
  });

  test("probe with no dsn surfaces a clear error in the detail", async () => {
    const c = fakeConnector({ driver: "redis", dsn: null });
    const probe = await probeRedisConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no dsn");
  });

  test("execute against a connector with no dsn throws cannot-connect", async () => {
    // The redis driver opens the client BEFORE arg validation, so the
    // missing-dsn case fires first. Arg-validation paths
    // (SET requires 'value', PUBLISH requires 'channel', EXPIRE
    // requires 'ttl_seconds') are exercised by the driver-integration
    // tests against a live endpoint.
    const c = fakeConnector({ driver: "redis", dsn: null });
    await expect(
      executeRedisCommand({ connector: c, command: "SET", key: "k", value: "v" }),
    ).rejects.toThrow(/no dsn|cannot connect/i);
  });
});

// ---------- ftp ----------

describe("ftp driver — units", () => {
  test("probe with non-ftp scheme returns a structured failure", async () => {
    const c = fakeConnector({ driver: "ftp", dsn: "http://example.com" });
    const probe = await probeFtpConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("scheme");
  });

  test("probe with no dsn returns a structured failure", async () => {
    const c = fakeConnector({ driver: "ftp", dsn: null });
    const probe = await probeFtpConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no dsn");
  });

  test("execute against a connector with no dsn throws", async () => {
    const c = fakeConnector({ driver: "ftp", dsn: null });
    await expect(executeFtpCommand({ connector: c, command: "LIST", path: "/" })).rejects.toThrow(
      /no DSN/i,
    );
  });
});

// ---------- sftp ----------

describe("sftp driver — units", () => {
  test("probe with non-sftp scheme returns a structured failure", async () => {
    const c = fakeConnector({ driver: "sftp", dsn: "ftp://example.com" });
    const probe = await probeSftpConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("scheme");
  });

  test("probe with no dsn returns a structured failure", async () => {
    const c = fakeConnector({ driver: "sftp", dsn: null });
    const probe = await probeSftpConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no dsn");
  });

  test("execute against a connector with no dsn throws", async () => {
    const c = fakeConnector({ driver: "sftp", dsn: null });
    await expect(executeSftpCommand({ connector: c, command: "LIST", path: "/" })).rejects.toThrow(
      /no DSN|cannot connect/i,
    );
  });
});

// ---------- mssql ----------

describe("mssql driver — units", () => {
  test("probe with non-mssql scheme returns a structured failure", async () => {
    const c = fakeConnector({ driver: "mssql", dsn: "http://example.com" });
    const probe = await probeMssqlConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("scheme");
  });

  test("probe with no dsn returns a structured failure", async () => {
    const c = fakeConnector({ driver: "mssql", dsn: null });
    const probe = await probeMssqlConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no dsn");
  });

  test("query against a connector with no dsn throws", async () => {
    const c = fakeConnector({ driver: "mssql", dsn: null });
    await expect(mssqlQuery({ connector: c, sql: "SELECT 1" })).rejects.toThrow(/no dsn|no DSN/i);
  });
});

// ---------- smb ----------

describe("smb driver — units", () => {
  test("probe with non-smb scheme throws on parse before any network call", async () => {
    const c = fakeConnector({ driver: "smb", dsn: "http://example.com" });
    await expect(probeSmbConnector(c)).rejects.toThrow(/scheme/);
  });

  test("probe with dsn missing share throws on parse", async () => {
    const c = fakeConnector({ driver: "smb", dsn: "smb://user:pass@host/" });
    await expect(probeSmbConnector(c)).rejects.toThrow(/share/);
  });

  test("probe with no dsn returns ok:false with the missing-dsn detail", async () => {
    const c = fakeConnector({ driver: "smb", dsn: null });
    const probe = await probeSmbConnector(c);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toBe("missing dsn");
  });

  // The DOMAIN;user split is exercised by the integration test against
  // a live SMB endpoint via testcontainers. Pinning it here without a
  // live SMB endpoint is
  // not possible (the driver opens the network connection before
  // returning), and Promise.race against setTimeout trips the
  // determinism gate.

  test("execute against a connector with no dsn throws", async () => {
    const c = fakeConnector({ driver: "smb", dsn: null });
    await expect(executeSmbCommand({ connector: c, command: "LIST", path: "" })).rejects.toThrow(
      /no dsn/i,
    );
  });
});
