import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { connectors, credentials } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import {
  _resetDraftCredentialCacheForTests,
  setDraftCredential,
} from "../../persistence/draft-credential-cache.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../probe-connector-draft.ts";
import { validateConnectorDraftTool } from "../validate-connector-draft.ts";

async function freshenCheckpoints(base: Parameters<typeof probeConnectorDraftTool.execute>[0]) {
  await inspectConnectorDraftTool.execute(base, {});
  await validateConnectorDraftTool.execute(base, {});
}

let ctx: ConversationTestCtx;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

const seenAuthHeaders: string[] = [];
let tokenEndpointMode: "ok" | "unauthorized" = "ok";

beforeAll(async () => {
  ctx = await createConversationTestCtx("probe_m2m_oauth");
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/token") {
        if (tokenEndpointMode === "unauthorized") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid client credentials" }));
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {}
        if (body.client_id !== "cid-1" || body.client_secret !== "sec-1") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad pair" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end('"jwt-minted-token"');
        return;
      }
      const auth = req.headers.authorization ?? "";
      seenAuthHeaders.push(auth);
      if (auth === "Bearer jwt-minted-token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "secured" }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.cleanup();
});

afterEach(async () => {
  _resetDraftCredentialCacheForTests();
  seenAuthHeaders.length = 0;
  tokenEndpointMode = "ok";
  await ctx.testDb.db.delete(credentials).where(eq(credentials.tenant_id, ctx.tenant_id));
  await ctx.testDb.db.delete(connectors).where(eq(connectors.tenant_id, ctx.tenant_id));
});

async function createToolCtxWithM2mDraft(opts?: { grant_type?: string }) {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "probe-m2m-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  draft = {
    ...draft,
    connector: {
      name: "M2M Upstream",
      slug: "m2m-upstream",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "oauth2",
      config: {
        oauth: {
          grant_type: opts?.grant_type ?? "client_credentials_json",
          token_endpoint: `${baseUrl}/token`,
          token_response_format: "raw",
          token_response_ttl_ms: 86_400_000,
        },
      },
    },
  };
  const base = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
  return { base, conversation_id: created.conversation.id };
}

describe("probe_connector_draft × client_credentials_json", () => {
  test("mints inline and probes with the exchanged bearer", async () => {
    const { base, conversation_id } = await createToolCtxWithM2mDraft();
    setDraftCredential(conversation_id, {
      mode: "oauth2",
      client_id: "cid-1",
      client_secret: "sec-1",
    });

    await freshenCheckpoints(base);
    const result = await probeConnectorDraftTool.execute(base, {});
    const data = result.data as {
      error_code?: string;
      latest_probe?: { ok?: boolean; status_code?: number } | null;
    };
    expect(data.error_code).not.toBe("authenticate_oauth_required");
    expect(seenAuthHeaders).toContain("Bearer jwt-minted-token");
    expect(data.latest_probe?.ok).toBe(true);
  });

  test("failed exchange returns token_exchange_failed naming the endpoint", async () => {
    tokenEndpointMode = "unauthorized";
    const { base, conversation_id } = await createToolCtxWithM2mDraft();
    setDraftCredential(conversation_id, {
      mode: "oauth2",
      client_id: "cid-1",
      client_secret: "wrong",
    });

    await freshenCheckpoints(base);
    const result = await probeConnectorDraftTool.execute(base, {});
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; error?: string };
    expect(data.error_code).toBe("token_exchange_failed");
    expect(String(data.error)).toContain("/token");
    expect(seenAuthHeaders.length).toBe(0);
  });

  test("non-M2M oauth2 drafts keep the browser-flow gate", async () => {
    const { base, conversation_id } = await createToolCtxWithM2mDraft({
      grant_type: "authorization_code",
    });
    setDraftCredential(conversation_id, {
      mode: "oauth2",
      client_id: "cid-1",
      client_secret: "sec-1",
    });

    await freshenCheckpoints(base);
    const result = await probeConnectorDraftTool.execute(base, {});
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    expect(data.error_code).toBe("authenticate_oauth_required");
  });
});
