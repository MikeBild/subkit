import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, ne } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../../audit/audit.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

export interface ConnectorWorld {
  readonly ctx: HttpTestServer;
  readonly deniedKey: string;
  readonly writerKey: string;
}

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const UUID =
  /(?<![0-9a-f-])(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;

async function seedUser(ctx: HttpTestServer, email: string, roleId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id: roleId })
    .returning();
  if (!row) throw new Error(`seed ${email} returned no row`);
  return row.id;
}

async function seedKey(ctx: HttpTestServer, userId: string, seed: number): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      userId,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

export async function seedConnectorWorld(name: string): Promise<ConnectorWorld> {
  const ctx = await createHttpTestServer(name);
  const deniedUserId = await seedUser(
    ctx,
    `denied-${name}@test.local`,
    await emptyRoleId(ctx.db, ctx.tenantId),
  );
  const writerRole = await createRole(ctx.db, ctx.tenantId, `${name}-writer`);
  for (const permission of [
    "connector:read",
    "connector:write",
    "connector:test",
    "credential:write",
  ]) {
    await grantPermissionToRole(ctx.db, ctx.tenantId, writerRole.id, permission);
  }
  const writerUserId = await seedUser(ctx, `writer-${name}@test.local`, writerRole.id);
  return {
    ctx,
    deniedKey: await seedKey(ctx, deniedUserId, 0xc0_d0),
    writerKey: await seedKey(ctx, writerUserId, 0xc0_d1),
  };
}

export class GoldenRecorder {
  readonly actual: Record<string, string> = {};
  private readonly golden: Record<string, string>;
  private readonly uuidNames = new Map<string, string>();

  constructor(
    path: string,
    private readonly world: () => ConnectorWorld,
    private readonly extra: (text: string) => string = (text) => text,
  ) {
    this.golden = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  }

  private uuidName(uuid: string): string {
    const known = this.uuidNames.get(uuid);
    if (known) return known;
    const name = `<uuid:${this.uuidNames.size + 1}>`;
    this.uuidNames.set(uuid, name);
    return name;
  }

  normalize(value: unknown): string {
    const { ctx } = this.world();
    return this.extra(
      JSON.stringify(value)
        .replaceAll(ctx.tenantId, "<tenant>")
        .replaceAll(ctx.baseUrl, "<base>")
        .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
        .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
        .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
        .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
        .replace(/"latency_ms":\d+(\.\d+)?/g, '"latency_ms":"<ms>"'),
    ).replace(UUID, (m) => this.uuidName(m));
  }

  private compare(name: string, text: string): void {
    this.actual[name] = text;
    if (Object.hasOwn(this.golden, name)) expect(text).toBe(this.golden[name] as string);
  }

  record(name: string, value: unknown): void {
    this.compare(name, this.normalize(value));
  }

  recordDigest(name: string, value: unknown): void {
    this.compare(name, createHash("sha256").update(this.normalize(value)).digest("hex"));
  }

  keys(): { actual: string[]; golden: string[] } {
    return { actual: Object.keys(this.actual).sort(), golden: Object.keys(this.golden).sort() };
  }
}

export async function call(
  w: ConnectorWorld,
  method: string,
  path: string,
  body?: unknown,
  key = w.ctx.apiKey,
): Promise<Answer> {
  const res = await fetch(`${w.ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function connectorAuditTrail(w: ConnectorWorld) {
  await _drainAuditWritesForTests(w.ctx.db);
  const rows = await w.ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, w.ctx.tenantId), ne(auditLog.action, "api_key.used")));
  const key = (row: (typeof rows)[number]) =>
    JSON.stringify({ ...row, resource_id: null })
      .replace(UUID, "<uuid>")
      .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
      .replace(/"latency_ms":\d+(\.\d+)?/g, '"latency_ms":"<ms>"');
  return rows.toSorted((a, b) => key(a).localeCompare(key(b)));
}
