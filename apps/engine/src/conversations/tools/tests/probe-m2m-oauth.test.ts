// probe_connector_draft × client_credentials_json (M2M OAuth2).
//
// Live failure (session 35a3b9ba, sk 6.17.0): the user filled the
// credential form for the xray-cloud draft (client_id + client_secret,
// cached as a mode:"oauth2" draft credential) and the probe refused
// with `authenticate_oauth_required` — "save, then run
// authenticate_oauth and complete the browser exchange". For a
// client-credentials grant there IS no browser: the engine can mint
// the bearer inline (the cognito_user_password branch is the
// precedent) and probe with it.
//
// Pins:
//   - an M2M draft + cached client creds → the probe POSTs the JSON
//     exchange to config.oauth.token_endpoint, strips the raw quoted
//     JWT, and probes WITH the minted bearer (upstream sees it).
//   - a failed exchange (401 from the token endpoint) → structured
//     `token_exchange_failed` envelope naming the endpoint — a real
//     verdict on bad credentials, not a browser-dance dead end.
//   - a NON-M2M oauth2 draft keeps the existing browser-flow gate
//     (`authenticate_oauth_required`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { connectors, credentials } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
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

/** Run the inspect → validate checkpoints the authoring state machine
 *  requires before a probe (mirrors the real guided flow). */
async function freshenCheckpoints(base: Parameters<typeof probeConnectorDraftTool.execute>[0]) {
  await inspectConnectorDraftTool.execute(base, {});
  await validateConnectorDraftTool.execute(base, {});
}

// Sibling suites in the same bun worker spy on `globalThis.fetch` and a
// leaked / mid-restore spy would route our token mint to a stub
// response ("Welcome to Bun!" became the bearer in one concurrent
// run). Force-restore the real fetch before every test — same defense
// as save-connector-draft-reissue.test.ts.
const ORIGINAL_FETCH = globalThis.fetch;

let ctx: ConversationTestCtx;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

/** Authorization header values the secured upstream observed. */
const seenAuthHeaders: string[] = [];
/** Token-endpoint behavior toggle for the failure test. */
let tokenEndpointMode: "ok" | "unauthorized" = "ok";

beforeAll(async () => {
  ctx = await createConversationTestCtx("probe_m2m_oauth");
  // node:http (not Bun.serve) on purpose — the engine HTTP test harness
  // interferes with in-process Bun.serve instances; http/tests/setup.ts
  // made the same choice for the same reason.
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
        } catch {
          /* fall through to bad-pair */
        }
        if (body.client_id !== "cid-1" || body.client_secret !== "sec-1") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad pair" }));
          return;
        }
        // Xray-style: the body is a bare QUOTED JWT string.
        res.writeHead(200, { "content-type": "text/plain" });
        res.end('"jwt-minted-token"');
        return;
      }
      // Everything except /token is the secured upstream (the probe
      // GETs the connector's base path).
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

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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
    // The probe must have reached the secured upstream WITH the minted
    // bearer — not been blocked by the browser-flow gate.
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
    // The upstream must never have been hit without a token.
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
