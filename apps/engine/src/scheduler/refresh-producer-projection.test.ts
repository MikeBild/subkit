import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  parseRefreshProjection,
  REFRESH_ADDRESS_MAX_BYTES,
  REFRESH_CRON_MAX_BYTES,
  REFRESH_SOURCE_TYPE_MAX_BYTES,
  refreshProjectionQuery,
} from "./refresh-producer-projection.ts";
import type { SweepLease } from "./sweep-cursor.ts";

const uuid = createDeterministicUuidFactory(0x5c0ef);
const now = new Date(getTestNow());
const candidate = { id: uuid(), tenant_id: uuid(), created_at: now };
const lease: SweepLease = {
  producer: "docs",
  epoch: 1,
  revision: 1,
  after_id: uuid(),
  epoch_upper_id: uuid(),
  epoch_cutoff_at: now,
  owner_boot_id: uuid(),
  lease_token: uuid(),
  lease_until: new Date(now.getTime() + 60_000),
};
function projection(source_type = "openapi") {
  return {
    cron: "every:60",
    last_fired_at: null,
    source_type,
    address: "https://example.test/docs",
  };
}

test("address-capable docs types retain the exact private address and cron without normalizing text", () => {
  const address = "postgresql://fixture.invalid/database?application_name=refresh";
  for (const source of [
    "openapi",
    "google_discovery",
    "markdown",
    "llms_txt",
    "graphql",
    "postgres",
    "cascade",
  ] as const) {
    const result = parseRefreshProjection("docs", {
      ...projection(source),
      cron: " every:60 ",
      address,
    });
    expect(result).toEqual({
      kind: "ready",
      producer: "docs",
      input: { cron: " every:60 ", last_fired_at: null, source_type: source, address },
    });
  }
});

test("unsupported worker types and JSON coercions cannot become refresh requests", () => {
  for (const source of ["file_upload", "unknown", "", { openapi: true }, 3]) {
    expect(parseRefreshProjection("docs", { ...projection(), source_type: source })).toEqual({
      kind: "unsupported",
    });
  }
  for (const address of [null, "", 3, { url: "https://example.test" }, ["https://example.test"]]) {
    expect(parseRefreshProjection("docs", { ...projection(), address })).toEqual({
      kind: "unsupported",
    });
  }
  expect(parseRefreshProjection("docs", { ...projection(), cron: " \t " })).toEqual({
    kind: "unsupported",
  });
});

test("UTF-8 byte caps reject overflow without truncating boundary values", () => {
  const address = "é".repeat(REFRESH_ADDRESS_MAX_BYTES / 2);
  const result = parseRefreshProjection("docs", { ...projection(), address });
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("missing exact-boundary address");
  expect(result.input.address).toBe(address);
  for (const patch of [
    { address: `${address}é` },
    { cron: "é".repeat(REFRESH_CRON_MAX_BYTES / 2 + 1) },
    { source_type: "é".repeat(REFRESH_SOURCE_TYPE_MAX_BYTES / 2 + 1) },
  ]) {
    expect(parseRefreshProjection("docs", { ...projection(), ...patch })).toEqual({
      kind: "unsupported",
    });
  }
});

test("knowledge retains the URL re-read contract and validates its scalar business-time baseline", () => {
  const result = parseRefreshProjection("knowledge", {
    ...projection("url"),
    last_fired_at: `${now.toISOString().slice(0, -1).replace("T", " ")}456+00`,
  });
  expect(result).toMatchObject({
    kind: "ready",
    producer: "knowledge",
    input: { source_type: "url", last_fired_at: now },
  });
  expect(parseRefreshProjection("knowledge", projection("bundle"))).toEqual({
    kind: "unsupported",
  });
  for (const last_fired_at of [
    "unavailable",
    `${now.toISOString().slice(0, 5)}99${now.toISOString().slice(7)}`,
    3,
  ]) {
    expect(parseRefreshProjection("knowledge", { ...projection("url"), last_fired_at })).toEqual({
      kind: "unsupported",
    });
  }
});

test("fixed projections guard source bytes on the server and retain precise range eligibility", () => {
  const dialect = new PgDialect();
  for (const producer of ["docs", "knowledge"] as const) {
    const rendered = dialect.sqlToQuery(refreshProjectionQuery(producer, candidate, lease));
    expect(rendered.sql).not.toContain("SELECT *");
    expect(rendered.sql).toContain("CASE WHEN octet_length(");
    expect(rendered.sql).toContain("created_at <=");
    expect(rendered.sql).not.toContain("created_at =");
    expect(rendered.sql).toContain("FOR UPDATE");
    expect(rendered.params).toContain(candidate.tenant_id);
    expect(rendered.params).toContain(candidate.id);
    expect(rendered.params).toContain(lease.epoch_upper_id);
    expect(rendered.params).toContain(lease.after_id);
    expect(rendered.params).toContain(REFRESH_ADDRESS_MAX_BYTES);
    expect(rendered.params).toContain(REFRESH_CRON_MAX_BYTES);
    if (producer === "docs") {
      expect(rendered.sql).toContain("jsonb_typeof(config -> 'docs_source_url') = 'string'");
      expect(rendered.sql).toContain("jsonb_typeof(config -> 'docs_source_type') = 'string'");
      expect(rendered.params).toContain(REFRESH_SOURCE_TYPE_MAX_BYTES);
    } else {
      expect(rendered.sql).toContain("source_type = 'url'");
      expect(rendered.sql).toContain("refresh_strategy = 'scheduled'");
      expect(rendered.sql).not.toContain("refresh_webhook_secret");
    }
  }
});
