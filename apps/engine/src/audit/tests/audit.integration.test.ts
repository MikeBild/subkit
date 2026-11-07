import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { withContext } from "../../logging/context.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { _drainAuditWritesForTests, audit, auditAwait, normalizeAuditActorId } from "../audit.ts";
import { getAuditRowById } from "../query.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb } from "./contracts-fixtures.ts";

useAuditContractsDb();

const uuid = createDeterministicUuidFactory(0xa0d17);

async function captureLogs(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = out as typeof process.stdout.write;
    process.stderr.write = err as typeof process.stderr.write;
  }
  return lines
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function rowsFor(resourceId: string) {
  return testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, resourceId));
}

describe("tenant resolution", () => {
  test("an entry without a tenant in the entry or the context is refused and writes no row", async () => {
    const resourceId = uuid();
    await expect(
      auditAwait(
        { action: "tenant.created", resource_type: "tenant", resource_id: resourceId },
        testDb.db,
      ),
    ).rejects.toThrow("tenant_id is required");
    expect(() =>
      audit({ action: "tenant.created", resource_type: "tenant", resource_id: resourceId }),
    ).toThrow("tenant_id is required");
    expect(await rowsFor(resourceId)).toEqual([]);
  });

  test("the context tenant scopes the row when the entry names none", async () => {
    const resourceId = uuid();
    const entry = await withContext({ tenant_id: tenantB }, () =>
      auditAwait(
        { action: "tenant.created", resource_type: "tenant", resource_id: resourceId },
        testDb.db,
      ),
    );
    expect(entry.tenant_id).toBe(tenantB);
    expect(await getAuditRowById(testDb.db, tenantB, entry.id)).not.toBeNull();
    expect(await getAuditRowById(testDb.db, tenantA, entry.id)).toBeNull();
  });

  test("an explicit entry tenant wins over the context tenant", async () => {
    const entry = await withContext({ tenant_id: tenantB }, () =>
      auditAwait({ tenant_id: tenantA, action: "tenant.created", resource_id: uuid() }, testDb.db),
    );
    const [row] = await rowsFor(entry.resource_id ?? "");
    expect(row?.tenant_id).toBe(tenantA);
  });

  test("an entry without action, resource type or result falls back to a system success row", async () => {
    const entry = await auditAwait({ tenant_id: tenantA, resource_id: uuid() }, testDb.db);
    const [row] = await rowsFor(entry.resource_id ?? "");
    expect(row?.action).toBe("system.startup");
    expect(row?.resource_type).toBe("system");
    expect(row?.result).toBe("success");
    expect(row?.actor_type).toBe("system");
    expect(row?.trace_id).toBeNull();
  });
});

describe("sensitive executions", () => {
  test("a sensitive execution keeps only the privacy marker and replaces the reason", async () => {
    const resourceId = uuid();
    const executionId = uuid();
    const entry = await withContext(
      { tenant_id: tenantA, execution_privacy: "sensitive", execution_id: executionId },
      () =>
        auditAwait(
          {
            action: "execution.completed",
            resource_type: "execution",
            resource_id: resourceId,
            reason: "customer Jane Doe owes 1200 EUR",
            before: { email: "jane@example.com" },
            after: { iban: "DE89370400440532013000" },
            metadata: { customer_email: "jane@example.com", step: "lookup" },
          },
          testDb.db,
        ),
    );
    const [row] = await rowsFor(resourceId);
    expect(row?.reason).toBe("sensitive_execution");
    expect(row?.before).toBeNull();
    expect(row?.after).toBeNull();
    expect(row?.metadata).toEqual({ execution_privacy: "sensitive", execution_id: executionId });
    expect(JSON.stringify(row)).not.toContain("jane@example.com");
    expect(entry.metadata).toEqual(row?.metadata as Record<string, unknown>);
  });

  test("a sensitive execution without a reason or execution id records neither", async () => {
    const resourceId = uuid();
    await withContext({ tenant_id: tenantA, execution_privacy: "sensitive" }, () =>
      auditAwait({ action: "execution.started", resource_id: resourceId }, testDb.db),
    );
    const [row] = await rowsFor(resourceId);
    expect(row?.reason).toBeNull();
    expect(row?.metadata).toEqual({ execution_privacy: "sensitive" });
  });
});

describe("request attribution from the trusted context", () => {
  test("the context request source is recorded unless the entry already names one", async () => {
    const implicit = uuid();
    const explicit = uuid();
    await withContext({ tenant_id: tenantA, request_source: "mcp" }, async () => {
      await auditAwait({ action: "tenant.created", resource_id: implicit }, testDb.db);
      await auditAwait(
        { action: "tenant.created", resource_id: explicit, metadata: { request_source: "cli" } },
        testDb.db,
      );
    });
    expect((await rowsFor(implicit))[0]?.metadata).toEqual({ request_source: "mcp" });
    expect((await rowsFor(explicit))[0]?.metadata).toEqual({ request_source: "cli" });
  });

  test("forged provenance keys in entry metadata are dropped when the context has none", async () => {
    const resourceId = uuid();
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_id: resourceId,
        metadata: {
          kept: "yes",
          origin_source: "api",
          execution_source: "api",
          audit_trace_id: "forged-trace",
          audit_used_api_key_id: uuid(),
          audit_used_session_id: uuid(),
          audit_access_type: "api_key",
          audit_oauth_client_id: "forged-client",
          audit_credential_origin: "cli_oauth_session",
        },
      },
      testDb.db,
    );
    expect((await rowsFor(resourceId))[0]?.metadata).toEqual({ kept: "yes" });
  });

  test("the context provenance overrides whatever the entry metadata claims", async () => {
    const resourceId = uuid();
    const conversationId = uuid();
    await withContext(
      {
        tenant_id: tenantA,
        audit_origin_source: "chat",
        audit_execution_source: "scheduler",
        audit_trace_id: "trace-real",
        conversation_id: conversationId,
        audit_access_type: "mcp_oauth",
        audit_oauth_client_id: "client-real",
        audit_credential_origin: "cli_oauth_session",
      },
      () =>
        auditAwait(
          {
            action: "tenant.created",
            resource_id: resourceId,
            metadata: {
              origin_source: "api",
              execution_source: "api",
              audit_trace_id: "trace-forged",
              audit_access_type: "api_key",
              audit_oauth_client_id: "client-forged",
            },
          },
          testDb.db,
        ),
    );
    expect((await rowsFor(resourceId))[0]?.metadata).toEqual({
      origin_source: "chat",
      execution_source: "scheduler",
      audit_trace_id: "trace-real",
      conversation_id: conversationId,
      audit_access_type: "mcp_oauth",
      audit_oauth_client_id: "client-real",
      audit_credential_origin: "cli_oauth_session",
    });
  });

  test("a non-UUID credential id is never recorded as a verified credential", async () => {
    const resourceId = uuid();
    await withContext(
      { tenant_id: tenantA, api_key_id: "not-a-uuid", session_id: "also-not-a-uuid" },
      () => auditAwait({ action: "tenant.created", resource_id: resourceId }, testDb.db),
    );
    const metadata = (await rowsFor(resourceId))[0]?.metadata as Record<string, unknown>;
    expect(metadata.audit_used_api_key_id).toBeUndefined();
    expect(metadata.audit_used_session_id).toBeUndefined();
    expect(metadata.session_id).toBe("also-not-a-uuid");
  });

  test("a UUID credential from the context replaces a forged api_key_id in the entry", async () => {
    const resourceId = uuid();
    const apiKeyId = uuid();
    const sessionId = uuid();
    await withContext({ tenant_id: tenantA, api_key_id: apiKeyId, session_id: sessionId }, () =>
      auditAwait(
        { action: "tenant.created", resource_id: resourceId, metadata: { api_key_id: uuid() } },
        testDb.db,
      ),
    );
    const metadata = (await rowsFor(resourceId))[0]?.metadata as Record<string, unknown>;
    expect(metadata.api_key_id).toBe(apiKeyId);
    expect(metadata.audit_used_api_key_id).toBe(apiKeyId);
    expect(metadata.session_id).toBe(sessionId);
    expect(metadata.audit_used_session_id).toBe(sessionId);
  });

  test("the context trace id is stored and an entry trace id wins over it", async () => {
    const fromContext = uuid();
    const fromEntry = uuid();
    await withContext({ tenant_id: tenantA, trace_id: "ctx-trace" }, async () => {
      await auditAwait({ action: "tenant.created", resource_id: fromContext }, testDb.db);
      await auditAwait(
        { action: "tenant.created", resource_id: fromEntry, trace_id: "entry-trace" },
        testDb.db,
      );
    });
    expect((await rowsFor(fromContext))[0]?.trace_id).toBe("ctx-trace");
    expect((await rowsFor(fromEntry))[0]?.trace_id).toBe("entry-trace");
  });
});

describe("token-exchange marker", () => {
  async function viaFor(metadata: Record<string, unknown>) {
    const resourceId = uuid();
    await withContext({ tenant_id: tenantA, auth_via: "token_exchange" }, () =>
      auditAwait({ action: "tenant.created", resource_id: resourceId, metadata }, testDb.db),
    );
    return (await rowsFor(resourceId))[0]?.metadata;
  }

  test("an entry without a via field records the token exchange as via", async () => {
    expect(await viaFor({})).toEqual({ via: "token_exchange" });
  });

  test("an entry whose via already says token_exchange is kept unchanged", async () => {
    expect(await viaFor({ via: "token_exchange" })).toEqual({ via: "token_exchange" });
  });

  test("an entry with a different via keeps it and records the exchange as auth_via", async () => {
    expect(await viaFor({ via: "mcp_tool" })).toEqual({
      via: "mcp_tool",
      auth_via: "token_exchange",
    });
  });

  test("an entry that already carries auth_via is not overwritten", async () => {
    expect(await viaFor({ via: "mcp_tool", auth_via: "portal" })).toEqual({
      via: "mcp_tool",
      auth_via: "portal",
    });
  });
});

describe("actor normalization", () => {
  test("only a UUID actor id is kept", () => {
    const id = uuid();
    expect(normalizeAuditActorId(id)).toBe(id);
    expect(normalizeAuditActorId(id.toUpperCase())).toBe(id.toUpperCase());
    expect(normalizeAuditActorId(`${id}x`)).toBeNull();
    expect(normalizeAuditActorId(`x${id}`)).toBeNull();
    expect(normalizeAuditActorId("")).toBeNull();
    expect(normalizeAuditActorId(null)).toBeNull();
    expect(normalizeAuditActorId(undefined)).toBeNull();
  });
});

describe("fire-and-forget writer", () => {
  test("audit returns the entry immediately and the row lands after the drain", async () => {
    const resourceId = uuid();
    const entry = audit(
      { tenant_id: tenantA, action: "tenant.created", resource_id: resourceId },
      testDb.db,
    );
    await _drainAuditWritesForTests(testDb.db);
    const [row] = await rowsFor(resourceId);
    expect(row?.id).toBe(entry.id);
  });

  test("audit inside a rolled-back transaction leaves no row", async () => {
    const resourceId = uuid();
    await expect(
      testDb.db.transaction(async (tx) => {
        audit({ tenant_id: tenantA, action: "tenant.created", resource_id: resourceId }, tx);
        await _drainAuditWritesForTests(tx);
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    expect(await rowsFor(resourceId)).toEqual([]);
  });

  test("a failed persist does not throw into the caller and writes nothing", async () => {
    const resourceId = uuid();
    const entry = audit(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_id: resourceId,
        ts: new Date(Number.NaN),
      },
      testDb.db,
    );
    await _drainAuditWritesForTests(testDb.db);
    expect(entry.resource_id).toBe(resourceId);
    expect(await rowsFor(resourceId)).toEqual([]);
  });

  test("auditAwait surfaces a failed persist to the caller", async () => {
    const resourceId = uuid();
    await expect(
      auditAwait(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_id: resourceId,
          ts: new Date(Number.NaN),
        },
        testDb.db,
      ),
    ).rejects.toThrow();
    expect(await rowsFor(resourceId)).toEqual([]);
  });

  test("an explicit id and timestamp are persisted as given", async () => {
    const id = uuid();
    const resourceId = uuid();
    await auditAwait(
      {
        id,
        ts: new Date(FROZEN_NOW),
        tenant_id: tenantA,
        action: "tenant.created",
        resource_id: resourceId,
        ip: "203.0.113.7",
        user_agent: "sk-cli/1.0",
      },
      testDb.db,
    );
    const [row] = await rowsFor(resourceId);
    expect(row?.id).toBe(id);
    expect(row?.ts.getTime()).toBe(FROZEN_NOW);
    expect(row?.ip).toBe("203.0.113.7");
    expect(row?.user_agent).toBe("sk-cli/1.0");
  });
});

describe("audit log lines", () => {
  const PAT = "dop_v1_loglineabcdefabcdefabcdefabcdefabcdefab";

  test("both writers log each recorded entry with scrubbed metadata only", async () => {
    const resourceId = uuid();
    const logs = await captureLogs(async () => {
      audit(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_id: resourceId,
          metadata: { token: PAT },
        },
        testDb.db,
      );
      await _drainAuditWritesForTests(testDb.db);
      await auditAwait(
        {
          tenant_id: tenantA,
          action: "tenant.updated",
          resource_id: resourceId,
          metadata: { token: PAT },
        },
        testDb.db,
      );
    });
    const recorded = logs.filter((line) => line.msg === "audit entry recorded");
    expect(
      recorded.map((line) => [line.module, line.action, line.resource_id, line.tenant_id]),
    ).toEqual([
      ["audit", "tenant.created", resourceId, tenantA],
      ["audit", "tenant.updated", resourceId, tenantA],
    ]);
    expect(JSON.stringify(logs)).not.toContain(PAT);
  });

  test("a lost fire-and-forget write is reported with the audit id", async () => {
    let id = "";
    const logs = await captureLogs(async () => {
      id = audit(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_id: uuid(),
          ts: new Date(Number.NaN),
        },
        testDb.db,
      ).id;
      await _drainAuditWritesForTests(testDb.db);
    });
    const failure = logs.find((line) => line.action === "audit.persist_failed");
    expect(failure?.module).toBe("audit");
    expect(failure?.msg).toBe("failed to persist audit row");
    expect(failure?.audit_id).toBe(id);
    expect(typeof failure?.error).toBe("string");
  });
});
