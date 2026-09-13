// Tenant isolation integration tests for the files resource.
//
// Verifies that tenant A's files are invisible to tenant B across
// three access paths: HTTP GET metadata, HTTP POST /links, and
// MCP read_resource. Real Postgres + config loaded.

import { createHash } from "node:crypto";

import type {
  ListResourcesRequest,
  ListResourcesResult,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ResolvedPrincipal } from "../auth/types.ts";
import { apiKeys, conversations, tenants, users } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { registerResourcesCapability } from "../mcp/capabilities/resources.ts";
import { PubSubEmitter } from "../pubsub/emitter.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../test-helpers/determinism/ids.ts";
import { attachInlineForTest } from "./test-helpers.ts";

// Deterministic id sources: seeded per-test so plays back identically.
// createHttpTestServer / createTestDb provision a fresh DB per run, so
// per-call uniqueness within the test is sufficient.
const uuid = createDeterministicUuidFactory(0x1501a7);
const nextHex = createDeterministicHexFactory(0x150bbb);

type RequestHandlerEntry = {
  schema: { shape: { method: { value: string } } };
  handler: (req: unknown) => Promise<unknown>;
};

interface StubServer {
  setRequestHandler: (schema: unknown, handler: (req: unknown) => Promise<unknown>) => void;
  registerCapabilities: (caps: unknown) => void;
  sendResourceUpdated: (p: { uri: string }) => Promise<void>;
  onclose?: () => void;
  handlers: RequestHandlerEntry[];
}

function newStub(): StubServer {
  const handlers: RequestHandlerEntry[] = [];
  return {
    handlers,
    setRequestHandler(schema, handler) {
      handlers.push({ schema: schema as RequestHandlerEntry["schema"], handler });
    },
    registerCapabilities: () => {},
    sendResourceUpdated: async () => {},
  };
}

function handlerFor(stub: StubServer, method: string) {
  const e = stub.handlers.find((h) => h.schema.shape.method.value === method);
  if (!e) throw new Error(`no handler for ${method}`);
  return e.handler;
}

let srv: HttpTestServer;
let tenantBId: string;
let tenantBKey: string;
let fidA: string; // wire fid_<uuid>
let fidAUuid: string; // raw UUID

beforeAll(async () => {
  srv = await createHttpTestServer("files-tenant-iso");

  // Seed tenant B
  const [tB] = await srv.db
    .insert(tenants)
    .values({ slug: "iso-b", display_name: "Iso B" })
    .returning();
  if (!tB) throw new Error("seed tenant B");
  tenantBId = tB.id;

  const [uB] = await srv.db
    .insert(users)
    .values({ tenant_id: tenantBId, email: "admin@iso-b.local", role: "admin" })
    .returning();
  if (!uB) throw new Error("seed user B");
  // Deterministic 24 bytes encoded base64url, then sliced like the
  // original randomBytes(24).toString("base64url").slice(0, 32) call.
  const rand = Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32);
  const pt = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: tenantBId,
    user_id: uB.id,
    prefix: pt.slice(0, 12),
    token_sha256: createHash("sha256").update(pt).digest("hex"),
    scopes: ["*"],
  });
  tenantBKey = pt;

  // Seed a conversation + file for tenant A
  const [conv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conversation");

  const att = await attachInlineForTest({
    db: srv.db,
    tenant_id: srv.tenantId,
    conversation_id: conv.id,
    filename: "secret.txt",
    content: "tenant-a-secret",
    slug: "secret",
  });
  fidA = att.file_id;
  fidAUuid = att.file_uuid;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("tenant isolation — HTTP", () => {
  test("tenant A can GET their own file metadata", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/files/${fidA}`, {
      headers: { authorization: `Bearer ${srv.apiKey}`, connection: "close" },
    });
    expect(res.status).toBe(200);
  });

  test("tenant B GET /v1/files/:id for tenant A file → 404", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/files/${fidA}`, {
      headers: { authorization: `Bearer ${tenantBKey}`, connection: "close" },
    });
    expect(res.status).toBe(404);
  });

  test("tenant B POST /v1/files/:id/links for tenant A file → 404", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/files/${fidA}/links`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenantBKey}`,
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify({
        resource_type: "conversation",
        resource_id: uuid(),
        slug: "cross-tenant",
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("tenant isolation — MCP read_resource", () => {
  test("MCP read_resource('file://<fidAUuid>') with tenant B principal → throws", async () => {
    const stub = newStub();
    const principalB: ResolvedPrincipal = {
      id: uuid(),
      tenant_id: tenantBId,
      kind: "user",
      email: "admin@iso-b.local",
      roles: ["admin"],
      provider: "api_key",
      scopes: ["*"],
    };
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: principalB,
      emitter,
    });

    const readHandler = handlerFor(stub, "resources/read");
    const req: ReadResourceRequest = {
      method: "resources/read",
      params: { uri: `file://${fidAUuid}` },
    };
    await expect(readHandler(req)).rejects.toThrow();
  });

  test("MCP list_resources with tenant B does NOT include tenant A file UUID", async () => {
    const stub = newStub();
    const principalB: ResolvedPrincipal = {
      id: uuid(),
      tenant_id: tenantBId,
      kind: "user",
      email: "admin@iso-b.local",
      roles: ["admin"],
      provider: "api_key",
      scopes: ["*"],
    };
    const emitter = new PubSubEmitter();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: principalB,
      emitter,
    });

    const listHandler = handlerFor(stub, "resources/list");
    const req: ListResourcesRequest = { method: "resources/list", params: {} };
    const result = (await listHandler(req)) as ListResourcesResult;
    const uris = result.resources.map((r) => r.uri);
    expect(uris).not.toContain(`file://${fidAUuid}`);
  });
});
