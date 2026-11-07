import { beforeAll, describe, expect, test } from "bun:test";
import { type LogContext, withContext } from "../../logging/context.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { auditAwait } from "../audit.ts";
import {
  type AuditQueryFilters,
  queryAuditLog,
  searchAuditResources,
  streamAuditLog,
} from "../query.ts";
import type { AuditEntry } from "../types.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0x9e77);
const KEY = uuid();
const SESSION = uuid();
const EXECUTION = uuid();
const CONVERSATION = uuid();
const WORKFLOW = uuid();
const ids: Record<string, string> = {};

function idOf(name: string): string {
  const id = ids[name];
  if (!id) throw new Error(`no seeded row named ${name}`);
  return id;
}

async function seed(
  name: string,
  entry: Partial<AuditEntry>,
  ctx: LogContext = {},
  tenant = tenantA,
): Promise<void> {
  const written = await withContext(ctx, () =>
    auditAwait(
      { tenant_id: tenant, action: "tenant.created", resource_type: "probe", ...entry },
      testDb.db,
    ),
  );
  ids[name] = written.id;
}

async function idsFor(filters: Omit<AuditQueryFilters, "tenant_id">, tenant = tenantA) {
  const page = await queryAuditLog(testDb.db, { tenant_id: tenant, ...filters }, { limit: 500 });
  const names = Object.entries(ids)
    .filter(([, id]) => page.items.some((item) => item.id === id))
    .map(([name]) => name);
  expect(names.length).toBe(page.items.length);
  return names.sort();
}

beforeAll(async () => {
  await seed("key_verified", {}, { api_key_id: KEY, audit_access_type: "api_key" });
  await seed("key_legacy", { metadata: { api_key_id: KEY } });
  await seed(
    "key_claimed",
    { metadata: { api_key_id: KEY } },
    { audit_access_type: "browser_session" },
  );
  await seed("key_receipt", { action: "api_key.used", resource_type: "api_key", resource_id: KEY });
  await seed("key_other_tenant", {}, { api_key_id: KEY, audit_access_type: "api_key" }, tenantB);
  await seed("session_verified", {}, { session_id: SESSION, audit_access_type: "browser_session" });
  await seed("session_legacy", { metadata: { session_id: SESSION } });
  await seed(
    "session_claimed",
    { metadata: { session_id: SESSION } },
    { audit_access_type: "mcp_oauth", audit_oauth_client_id: "client-1" },
  );
  await seed("sources", {}, { audit_origin_source: "chat", audit_execution_source: "scheduler" });
  await seed("exec_resource", { resource_type: "execution", resource_id: EXECUTION });
  await seed("exec_metadata", { metadata: { execution_id: EXECUTION } });
  await seed("exec_wrong_type", { resource_type: "workflow", resource_id: EXECUTION });
  await seed("conv_resource", { resource_type: "conversation", resource_id: CONVERSATION });
  await seed("conv_context", {}, { conversation_id: CONVERSATION });
  await seed("wf_resource", { resource_type: "workflow", resource_id: WORKFLOW });
  await seed("wf_metadata", { metadata: { workflow_id: WORKFLOW } });
  await seed("correlated", {}, { audit_trace_id: "corr-1" });
  await seed("correlated_other_tenant", {}, { audit_trace_id: "corr-1" }, tenantB);
});

describe("credential filters", () => {
  test("api_key_id matches verified use, legacy unverified rows and use receipts only", async () => {
    expect(await idsFor({ api_key_id: KEY })).toEqual([
      "key_legacy",
      "key_receipt",
      "key_verified",
    ]);
  });

  test("a claimed api_key_id on a row with another recorded access type does not match", async () => {
    expect(await idsFor({ api_key_id: KEY })).not.toContain("key_claimed");
  });

  test("api_key_id never returns another tenant's rows", async () => {
    expect(await idsFor({ api_key_id: KEY }, tenantB)).toEqual(["key_other_tenant"]);
  });

  test("session_id matches verified and legacy rows but not a claim under another access type", async () => {
    expect(await idsFor({ session_id: SESSION })).toEqual(["session_legacy", "session_verified"]);
  });

  test("access_type and oauth_client_id narrow to the recorded access", async () => {
    expect(await idsFor({ access_type: "browser_session" })).toEqual([
      "key_claimed",
      "session_verified",
    ]);
    expect(await idsFor({ access_type: "api_key" })).toEqual(["key_verified"]);
    expect(await idsFor({ oauth_client_id: "client-1" })).toEqual(["session_claimed"]);
    expect(await idsFor({ oauth_client_id: "client-1" }, tenantB)).toEqual([]);
  });
});

describe("provenance filters", () => {
  test("origin_source and execution_source match the trusted context values", async () => {
    expect(await idsFor({ origin_source: "chat" })).toEqual(["sources"]);
    expect(await idsFor({ execution_source: "scheduler" })).toEqual(["sources"]);
    expect(await idsFor({ origin_source: "scheduler" })).toEqual([]);
  });

  test("correlation_id matches the audit trace id within the tenant only", async () => {
    expect(await idsFor({ correlation_id: "corr-1" })).toEqual(["correlated"]);
    expect(await idsFor({ correlation_id: "corr-1" }, tenantB)).toEqual([
      "correlated_other_tenant",
    ]);
  });
});

describe("related-resource filters", () => {
  test("execution_id matches the execution resource and rows that reference it", async () => {
    expect(await idsFor({ execution_id: EXECUTION })).toEqual(["exec_metadata", "exec_resource"]);
  });

  test("conversation_id matches the conversation resource and rows from its context", async () => {
    expect(await idsFor({ conversation_id: CONVERSATION })).toEqual([
      "conv_context",
      "conv_resource",
    ]);
  });

  test("workflow_id matches the workflow resource and rows that reference it", async () => {
    expect(await idsFor({ workflow_id: WORKFLOW })).toEqual(["wf_metadata", "wf_resource"]);
  });

  test("resource_types is an OR over the listed types and an empty list does not filter", async () => {
    expect(await idsFor({ resource_types: ["execution", "conversation"] })).toEqual([
      "conv_resource",
      "exec_resource",
    ]);
    const all = await idsFor({ resource_types: [] });
    expect(all.length).toBe(16);
  });
});

describe("cursor edges", () => {
  const base = FROZEN_NOW - 86_400_000;
  const at = (offset: number) => new Date(base + offset);

  beforeAll(async () => {
    await seed("t0", { resource_type: "cursor_probe", ts: at(0) });
    await seed("t1", { resource_type: "cursor_probe", ts: at(1) });
    await seed("t2", { resource_type: "cursor_probe", ts: at(2) });
  });

  test("a malformed cursor is rejected", async () => {
    await expect(
      queryAuditLog(testDb.db, { tenant_id: tenantA }, { cursor: "not-a-cursor" }),
    ).rejects.toThrow("invalid audit cursor");
    await expect(
      queryAuditLog(testDb.db, { tenant_id: tenantA }, { cursor: `${at(1).toISOString()}|zzz` }),
    ).rejects.toThrow("invalid audit cursor");
  });

  test("a cursor without fractional seconds is accepted", async () => {
    const page = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_type: "cursor_probe" },
      { cursor: at(1000).toISOString().replace(".000Z", "Z") },
    );
    expect(page.items.map((item) => item.id)).toEqual([idOf("t2"), idOf("t1"), idOf("t0")]);
    await expect(
      queryAuditLog(testDb.db, { tenant_id: tenantA }, { cursor: `x${at(1).toISOString()}` }),
    ).rejects.toThrow("invalid audit cursor");
  });

  test("a blank cursor starts at the first page", async () => {
    const page = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_type: "cursor_probe" },
      { cursor: "   " },
    );
    expect(page.items.map((item) => item.id)).toEqual([idOf("t2"), idOf("t1"), idOf("t0")]);
  });

  test("a timestamp-only cursor excludes rows at that instant and returns older ones", async () => {
    const page = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_type: "cursor_probe" },
      { cursor: at(1).toISOString() },
    );
    expect(page.items.map((item) => item.id)).toEqual([idOf("t0")]);
    expect(page.next_cursor).toBeNull();
  });

  test("a limit below one still returns one row and a continuation cursor", async () => {
    const page = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_type: "cursor_probe" },
      { limit: 0 },
    );
    expect(page.items.map((item) => item.id)).toEqual([idOf("t2")]);
    expect(page.next_cursor).toBe(`${at(2).toISOString().replace("Z", "000Z")}|${idOf("t2")}`);
    const next = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA, resource_type: "cursor_probe" },
      { limit: -5, cursor: page.next_cursor ?? "" },
    );
    expect(next.items.map((item) => item.id)).toEqual([idOf("t1")]);
  });

  test("streaming applies the same filters and tenant scope", async () => {
    const streamed: string[] = [];
    for await (const item of streamAuditLog(testDb.db, {
      tenant_id: tenantA,
      resource_type: "cursor_probe",
    })) {
      streamed.push(item.id);
    }
    expect(streamed).toEqual([idOf("t2"), idOf("t1"), idOf("t0")]);
    const foreign: string[] = [];
    for await (const item of streamAuditLog(testDb.db, {
      tenant_id: tenantB,
      resource_type: "cursor_probe",
    })) {
      foreign.push(item.id);
    }
    expect(foreign).toEqual([]);
  });
});

describe("request source and search", () => {
  beforeAll(async () => {
    await seed("from_webhook", { resource_type: "search_probe" }, { request_source: "webhook" });
    await seed("wf_percent", {
      action: "workflow.updated",
      resource_type: "workflow",
      resource_id: "wf-percent",
      after: { name: "50% off" },
    });
    await seed("wf_underscore", {
      action: "workflow.updated",
      resource_type: "workflow",
      resource_id: "wf-under",
      after: { name: "a_b" },
    });
    await seed("wf_plain", {
      action: "workflow.updated",
      resource_type: "workflow",
      resource_id: "wf-plain",
      after: { name: "  " },
    });
  });

  test("request_source narrows to rows from that source", async () => {
    expect(await idsFor({ request_source: "webhook" })).toEqual(["from_webhook"]);
    expect(await idsFor({ request_source: "webhook" }, tenantB)).toEqual([]);
  });

  test("an empty actions list does not filter and a listed action does", async () => {
    const all = await idsFor({ actions: [], resource_type: "workflow" });
    expect(all).toEqual([
      "exec_wrong_type",
      "wf_percent",
      "wf_plain",
      "wf_resource",
      "wf_underscore",
    ]);
    expect(await idsFor({ actions: ["workflow.updated"] })).toEqual([
      "wf_percent",
      "wf_plain",
      "wf_underscore",
    ]);
  });

  test("search treats % and _ literally", async () => {
    const percent = await searchAuditResources(testDb.db, tenantA, "%");
    expect(percent.map((match) => match.resource_id)).toEqual(["wf-percent"]);
    const underscore = await searchAuditResources(testDb.db, tenantA, "_");
    expect(underscore.map((match) => match.resource_id)).toEqual(["wf-under"]);
  });

  test("a blank historical name is reported as no name and the limit is at least one", async () => {
    const found = await searchAuditResources(testDb.db, tenantA, "wf-", "workflow", 0);
    expect(found.length).toBe(1);
    const plain = await searchAuditResources(testDb.db, tenantA, "wf-plain", "workflow");
    expect(plain.map((match) => [match.resource_id, match.resource_name])).toEqual([
      ["wf-plain", null],
    ]);
    expect(await searchAuditResources(testDb.db, tenantB, "wf-plain")).toEqual([]);
  });
});
