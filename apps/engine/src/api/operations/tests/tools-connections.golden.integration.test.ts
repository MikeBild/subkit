import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "../../../db/client.ts";
import { outboundConnections, vaultItems } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { seedConnector, seedTenant } from "../../../test-helpers/seed.ts";
import { staticToolProvider } from "../../../tools/providers/static.ts";
import { buildRegistry, type ToolListFilter } from "../../../tools/registry.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";
import type { ToolEnvelope } from "../../../tools/types.ts";

const GOLDEN_PATH = new URL("./fixtures/tools-connections.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const FILTERS: Record<string, ToolListFilter> = {
  chat: { surface: "chat" },
  mcp: { surface: "mcp" },
  "mcp.product": { surface: "mcp", mcpMode: "product" },
  "mcp.authoring": { surface: "mcp", mcpMode: "authoring" },
  "mcp.admin": { surface: "mcp", mcpMode: "admin" },
  "mcp.read_only": { surface: "mcp", mcpMode: "product", readOnly: true },
};

let tdb: TestDb;
let db: Db;
let tenantId: string;
let emptyTenantId: string;

function uuidName(uuid: string): string {
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function record(name: string, value: unknown): void {
  actual[name] = JSON.stringify(value ?? null)
    .replaceAll(tenantId, "<tenant>")
    .replaceAll(emptyTenantId, "<empty-tenant>")
    .replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function resolve(filter: ToolListFilter) {
  const entry = staticToolProvider.resolve("list_connections", filter);
  if (!entry) return null;
  const executor = entry.executor as {
    kind: string;
    tool: unknown;
    toolName: string;
    invoke: (ctx: never, args: Record<string, unknown>) => Promise<ToolEnvelope>;
  };
  return { descriptor: entry.descriptor, executor };
}

async function invoke(tenant_id: string): Promise<ToolEnvelope> {
  const entry = resolve({ surface: "mcp" });
  if (!entry) throw new Error("list_connections is not resolvable on mcp");
  const principal = makeTestPrincipal({ tenant_id, roles: ["admin"] });
  const ctx = {
    db,
    principal,
    registry: buildRegistry([staticToolProvider]),
    resumeApproval: async () => ({ status: "ok", data: null }) as ToolEnvelope,
  };
  return entry.executor.invoke(ctx as never, {});
}

beforeAll(async () => {
  tdb = await createTestDb("tools_connections_golden");
  db = tdb.db as unknown as Db;
  tenantId = (await seedTenant(db, { slug: "tools-connections-golden" })).id;
  emptyTenantId = (await seedTenant(db, { slug: "tools-connections-empty" })).id;
  const user = await seedConnector(db, { tenant_id: tenantId, slug: "golden-wiki-user" });
  const [wiki] = await db
    .insert(outboundConnections)
    .values({
      tenant_id: tenantId,
      name: "golden-wiki",
      base_url: "https://wiki.test",
      issuer: "https://wiki.test",
      authorization_endpoint: "https://wiki.test/authorize",
      token_endpoint: "https://wiki.test/token",
      client_id: "c",
      scopes: ["read", "offline_access"],
      granted_scopes: ["read", "offline_access"],
      access_token_version: 1,
      refresh_token_version: 1,
      expires_at: new Date("2026-01-10T12:00:00.000Z"),
      created_at: new Date("2026-01-01T12:00:00.000Z"),
      updated_at: new Date("2026-01-01T12:00:00.000Z"),
    })
    .returning();
  if (!wiki) throw new Error("connection fixture");
  await db.insert(outboundConnections).values({
    tenant_id: tenantId,
    name: "golden-expiring",
    base_url: "https://expiring.test",
    issuer: "https://expiring.test",
    authorization_endpoint: "https://expiring.test/authorize",
    token_endpoint: "https://expiring.test/token",
    client_id: "p",
    scopes: ["write"],
    access_token_version: 1,
    expires_at: new Date("2026-02-10T12:00:00.000Z"),
    created_at: new Date("2026-01-02T12:00:00.000Z"),
    updated_at: new Date("2026-01-02T12:00:00.000Z"),
  });
  await db.insert(vaultItems).values({
    tenant_id: tenantId,
    connector_id: user.id,
    environment: "prod",
    mode: "oauth2",
    ciphertext: Buffer.from("x"),
    iv: Buffer.from("x"),
    auth_tag: Buffer.from("x"),
    connection_id: wiki.id,
  });
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("list_connections keeps its MCP tool, descriptor and results", () => {
  test("tool and descriptor per surface", () => {
    for (const [name, filter] of Object.entries(FILTERS)) {
      const entry = resolve(filter);
      record(
        `resolve.${name}`,
        entry
          ? {
              descriptor: entry.descriptor,
              kind: entry.executor.kind,
              toolName: entry.executor.toolName,
              tool: entry.executor.tool,
            }
          : null,
      );
      record(
        `listed.${name}`,
        staticToolProvider
          .list(filter)
          .some((descriptor) => descriptor.name === "list_connections"),
      );
    }
  });

  test("invoke", async () => {
    record("invoke.tenant", await invoke(tenantId));
    record("invoke.empty", await invoke(emptyTenantId));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
