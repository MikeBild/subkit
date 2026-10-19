import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createSeededRandom } from "../../test-helpers/determinism/random.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";

const seededRand = createSeededRandom(0xb0_07ac7);

interface Principal {
  apiKey: string;
  tenantId: string;
  userId: string;
  role: "admin" | "member";
}

interface BoundaryCtx {
  testDb: TestDb;
  db: Db;
  baseUrl: string;
  cleanup: () => Promise<void>;
  tenantA: { admin: Principal; member: Principal };
  tenantB: { admin: Principal; member: Principal };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const bytes = seededRand.bytes(24);
  const rand = Buffer.from(bytes).toString("base64url").slice(0, 32);
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

async function seedPrincipal(
  db: Db,
  tenantId: string,
  email: string,
  role: "admin" | "member",
): Promise<Principal> {
  const [user] = await db
    .insert(users)
    .values({ tenant_id: tenantId, email, role_id: await builtinRoleId(db, role) })
    .returning();
  if (!user) throw new Error(`seed user failed (${email})`);
  const key = generateApiKey();
  await db.insert(apiKeys).values({
    tenant_id: tenantId,
    user_id: user.id,
    prefix: key.prefix,
    token_sha256: key.hash,
    scopes: ["*"],
  });
  return { apiKey: key.plaintext, tenantId, userId: user.id, role };
}

async function buildBoundaryCtx(): Promise<BoundaryCtx> {
  const testDb = await createTestDb("route-boundary");
  const [tenantARow] = await testDb.db
    .insert(tenants)
    .values({ slug: "boundary-a", display_name: "Boundary A" })
    .returning();
  const [tenantBRow] = await testDb.db
    .insert(tenants)
    .values({ slug: "boundary-b", display_name: "Boundary B" })
    .returning();
  if (!tenantARow || !tenantBRow) throw new Error("seed tenants failed");

  const tenantA = {
    admin: await seedPrincipal(testDb.db, tenantARow.id, "admin@a.local", "admin"),
    member: await seedPrincipal(testDb.db, tenantARow.id, "member@a.local", "member"),
  };
  const tenantB = {
    admin: await seedPrincipal(testDb.db, tenantBRow.id, "admin@b.local", "admin"),
    member: await seedPrincipal(testDb.db, tenantBRow.id, "member@b.local", "member"),
  };

  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry });
  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("port resolution failed");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const cleanup = async () => {
    const httpServer = server as unknown as {
      close: (cb: () => void) => void;
      closeAllConnections?: () => void;
    };
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await testDb.cleanup();
  };

  return { testDb, db: testDb.db, baseUrl, cleanup, tenantA, tenantB };
}

interface RouteSpec {
  label: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  resolvePath: (ctx: BoundaryCtx, scope: "tenantA" | "tenantB") => Promise<string>;
  validBody: (ctx: BoundaryCtx, scope: "tenantA" | "tenantB") => Record<string, unknown>;
  invalidBody: Record<string, unknown>;
  adminOnly: boolean;
  expectedAuditAction: string;
  successStatus?: number;
}

async function fetchAs(
  ctx: BoundaryCtx,
  principal: Principal,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${principal.apiKey}`,
      "content-type": "application/json",
      connection: "close",
    },
  };
  if (body) init.body = JSON.stringify(body);
  return fetch(`${ctx.baseUrl}${path}`, init);
}

async function countAuditRows(db: Db, tenantId: string, action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, action)));
  return rows.length;
}

const ROUTE_SPECS: RouteSpec[] = [
  {
    label: "POST /v1/identity/api-keys (admin-only)",
    method: "POST",
    pathTemplate: "/v1/identity/api-keys",
    adminOnly: true,
    expectedAuditAction: "api_key.issued",
    successStatus: 201,
    resolvePath: async () => "/v1/identity/api-keys",
    validBody: (ctx, scope) => ({
      owner_kind: "user",
      owner_id: ctx[scope].admin.userId,
      scopes: ["*"],
    }),
    invalidBody: { owner_kind: "not-a-real-kind" },
  },
  {
    label: "DELETE /v1/identity/api-keys/{id} (admin-only)",
    method: "DELETE",
    pathTemplate: "/v1/identity/api-keys/{id}",
    adminOnly: true,
    expectedAuditAction: "api_key.revoked",
    successStatus: 204,
    resolvePath: async (ctx, scope) => {
      const res = await fetchAs(ctx, ctx[scope].admin, "POST", "/v1/identity/api-keys", {
        owner_kind: "user",
        owner_id: ctx[scope].admin.userId,
        scopes: ["*"],
      });
      const body = (await res.json()) as { id?: string };
      if (!body.id) throw new Error(`could not seed api key on ${scope}: ${JSON.stringify(body)}`);
      return `/v1/identity/api-keys/${body.id}`;
    },
    validBody: () => ({}),
    invalidBody: {},
  },
  {
    label: "POST /v1/workflows (member can create)",
    method: "POST",
    pathTemplate: "/v1/workflows",
    adminOnly: false,
    expectedAuditAction: "workflow.created",
    successStatus: 201,
    resolvePath: async () => "/v1/workflows",
    validBody: () => ({
      name: "Boundary contract probe",
      steps: [
        { id: "s1", kind: "transform", expression: "return input.input;", language: "javascript" },
      ],
    }),
    invalidBody: { name: 42 },
  },
];

let ctx: BoundaryCtx;
let configDirectory: string;

beforeAll(async () => {
  configDirectory = mkdtempSync(join(tmpdir(), "sk-route-boundary-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://localhost/x", NODE_ENV: "test" },
    configPathOverride: join(configDirectory, "subkit.config.json"),
  });
  ctx = await buildBoundaryCtx();
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
  _resetConfigForTests();
  rmSync(configDirectory, { recursive: true, force: true });
}, 30_000);

describe("route-boundary contracts (HTTP)", () => {
  for (const spec of ROUTE_SPECS) {
    describe(spec.label, () => {
      test("(a) Zod rejects bad input with 400 bad_request", async () => {
        if (spec.method === "DELETE") {
          const path = spec.pathTemplate.replace("{id}", "not-a-uuid");
          const res = await fetchAs(ctx, ctx.tenantA.admin, spec.method, path);
          expect([400, 404]).toContain(res.status);
        } else {
          const path = await spec.resolvePath(ctx, "tenantA");
          const res = await fetchAs(ctx, ctx.tenantA.admin, spec.method, path, spec.invalidBody);
          expect(res.status).toBe(400);
          const body = (await res.json()) as { code: string };
          expect(body.code).toBe("bad_request");
        }
      });

      test("(b) RBAC: wrong principal denied", async () => {
        if (!spec.adminOnly) {
          return;
        }
        const path = await spec.resolvePath(ctx, "tenantA");
        const res = await fetchAs(
          ctx,
          ctx.tenantA.member,
          spec.method,
          path,
          spec.validBody(ctx, "tenantA"),
        );
        expect(res.status).toBe(403);
      });

      test("(c) tenant isolation: B principal cannot reach A resource", async () => {
        if (spec.method === "DELETE") {
          const pathOnA = await spec.resolvePath(ctx, "tenantA");
          const res = await fetchAs(ctx, ctx.tenantB.admin, spec.method, pathOnA);
          expect([403, 404]).toContain(res.status);
        } else {
          return;
        }
      });

      test("(d) success path writes an audit row", async () => {
        const before = await countAuditRows(
          ctx.db,
          ctx.tenantA.admin.tenantId,
          spec.expectedAuditAction,
        );
        const path = await spec.resolvePath(ctx, "tenantA");
        const res = await fetchAs(
          ctx,
          ctx.tenantA.admin,
          spec.method,
          path,
          spec.validBody(ctx, "tenantA"),
        );
        const expected = spec.successStatus ?? (spec.method === "DELETE" ? 204 : 201);
        if (res.status !== expected) {
          const text = await res.text();
          throw new Error(`${spec.label}: expected ${expected}, got ${res.status} — body: ${text}`);
        }
        const after = await countAuditRows(
          ctx.db,
          ctx.tenantA.admin.tenantId,
          spec.expectedAuditAction,
        );
        expect(after).toBeGreaterThan(before);
      });
    });
  }
});
