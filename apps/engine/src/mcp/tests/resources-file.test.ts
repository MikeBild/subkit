// Integration tests for MCP file://<fid> resource exposure.
//
// Covers:
//   - read_resource returns content for a ready file
//   - list_resources includes the file UUID
//   - soft-deleted files NOT in list_resources
//   - unknown fid → read_resource throws (no cross-tenant leak)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  ListResourcesRequest,
  ListResourcesResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { conversations, files } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { PubSubEmitter } from "../../pubsub/emitter.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { registerResourcesCapability } from "../capabilities/resources.ts";

// Deterministic uuid source: seeded so the test replays identically.
const uuid = createDeterministicUuidFactory(0x3c9f11);

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
let conversation_id: string;

beforeAll(async () => {
  srv = await createHttpTestServer("mcp-resources-file");

  const [conv] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conversation");
  conversation_id = conv.id;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

function makePrincipal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    id: uuid(),
    tenant_id: srv.tenantId,
    kind: "user",
    email: "admin@mcp-file.local",
    roles: ["admin"],
    provider: "api_key",
    scopes: ["*"],
    ...overrides,
  };
}

describe("MCP file:// resource", () => {
  test("read_resource returns text content for a text/plain file", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "mcp-read.txt",
      content: "mcp-content-hello",
      content_type: "text/plain",
      slug: `mcp-read-${uuid().slice(0, 8)}`,
    });

    const stub = newStub();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: makePrincipal(),
      emitter: new PubSubEmitter(),
    });

    const readHandler = handlerFor(stub, "resources/read");
    const req: ReadResourceRequest = {
      method: "resources/read",
      // MCP resources URI uses raw UUID (not fid_ prefix)
      params: { uri: `file://${att.file_uuid}` },
    };
    const result = (await readHandler(req)) as ReadResourceResult;
    expect(result.contents).toHaveLength(1);
    const c = result.contents[0]!;
    expect(c.uri).toBe(`file://${att.file_uuid}`);
    expect((c as { text?: string }).text).toBe("mcp-content-hello");
    expect(c.mimeType).toBe("text/plain");
  });

  test("list_resources includes ready file UUID", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "mcp-listed.txt",
      content: "listed-content",
      slug: `mcp-listed-${uuid().slice(0, 8)}`,
    });

    const stub = newStub();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: makePrincipal(),
      emitter: new PubSubEmitter(),
    });

    const listHandler = handlerFor(stub, "resources/list");
    const req: ListResourcesRequest = { method: "resources/list", params: {} };
    const result = (await listHandler(req)) as ListResourcesResult;
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain(`file://${att.file_uuid}`);
  });

  test("soft-deleted files NOT in list_resources", async () => {
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id,
      filename: "mcp-deleted.txt",
      content: "deleted-content",
      slug: `mcp-deleted-${uuid().slice(0, 8)}`,
    });

    // Soft-delete the file (FROZEN_NOW keeps the timestamp replayable).
    await srv.db
      .update(files)
      .set({ deleted_at: new Date(FROZEN_NOW) })
      .where(eq(files.id, att.file_uuid));

    const stub = newStub();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: makePrincipal(),
      emitter: new PubSubEmitter(),
    });

    const listHandler = handlerFor(stub, "resources/list");
    const req: ListResourcesRequest = { method: "resources/list", params: {} };
    const result = (await listHandler(req)) as ListResourcesResult;
    const uris = result.resources.map((r) => r.uri);
    expect(uris).not.toContain(`file://${att.file_uuid}`);
  });

  test("read_resource for unknown fid → throws", async () => {
    const stub = newStub();
    registerResourcesCapability({
      server: stub as never,
      db: srv.db,
      principal: makePrincipal(),
      emitter: new PubSubEmitter(),
    });

    const readHandler = handlerFor(stub, "resources/read");
    const req: ReadResourceRequest = {
      method: "resources/read",
      params: { uri: `file://${uuid()}` },
    };
    await expect(readHandler(req)).rejects.toThrow();
  });
});
