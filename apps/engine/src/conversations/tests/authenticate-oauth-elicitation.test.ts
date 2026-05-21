// authenticate_oauth — MCP elicitation URL-mode integration tests.
//
// Covers the load-bearing contract of MCP-native OAuth elicitation:
//
//   - URL-mode happy path: an oob-capable MCP client, the tool issues an
//     out-of-band `elicitation/create` with the authorization URL, then
//     blocks on `waitForOAuthCredential`. We simulate the OAuth callback
//     by landing a `credentials` row + dispatching the
//     `connector.oauth.callback_succeeded` event, and assert the
//     `connector_authenticated` checkpoint is marked ONLY after the
//     credential lands (not optimistically before).
//   - Failure path: a `callback_failed` event → `oauth_authorization_failed`,
//     and the checkpoint is NOT marked.
//
// A mock OIDC server backs `startAuthorizationCode` so no real provider
// is contacted; the MCP `ElicitationBridge` is a structural stub.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../credentials/oauth2/tests/mock-server.ts";
import {
  connectorOauthStates,
  connectors,
  conversations,
  credentials,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { ElicitationBridge, ElicitationResult } from "../../mcp/elicitation/bridge.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { startListener, stopListener } from "../../pubsub/listener.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../../tools/index.ts";
import { buildRegistry } from "../../tools/registry.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let mock: MockOAuthServer;
let tenant_id: string;
let conversation_id: string;
let priorBaseUrl = "";

const PLACEHOLDER = Buffer.from([0x01]);

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* not yet loaded */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-aoauth-elicit-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/aoauth-elicit", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  // The redirect_uri is synthesized from server.public_base_url; set it
  // so `buildOAuthRedirectUri` resolves without an external override.
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", "https://engine.test.example", { force: true });

  ctx = await createTestDb("authenticate_oauth_elicitation");
  mock = await startMockOAuthServer();

  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-aoe", display_name: "T-AOE" })
    .returning();
  tenant_id = t!.id;

  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  conversation_id = conv!.id;

  await startListener({
    connectionString: ctx.url,
    db: ctx.db,
    channels: ["connector.oauth"],
    listenerId: "aoe-test",
  });
});

afterAll(async () => {
  await stopListener();
  await mock.close();
  await setConfigKey("server.public_base_url", priorBaseUrl, { force: true });
  await ctx.cleanup();
});

/** A connector configured for OAuth2 against the local mock OIDC server. */
async function makeOAuthConnector(slug: string): Promise<string> {
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: `OAuth ${slug}`,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://api.example.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "test-client",
          client_secret: "test-secret",
          scope: "read",
        },
      },
    })
    .returning({ id: connectors.id });
  return c!.id;
}

/** Structural ElicitationBridge stub — only `.capabilities` + `.elicitOob`
 *  are reached on the oob path. */
function makeOobBridge(action: "accept" | "decline" = "accept"): ElicitationBridge {
  const fn = async (): Promise<ElicitationResult> => ({ action });
  return {
    capabilities: { form: true, oob: true },
    elicitForm: fn,
    elicitOob: fn,
  } as unknown as ElicitationBridge;
}

function succeededEvent(connectorId: string): EventEnvelope {
  return {
    id: 1,
    tenant_id,
    channel: "connector.oauth",
    type: "connector.oauth.callback_succeeded",
    payload: {
      connector_id: connectorId,
      connector_slug: "oauth",
      has_refresh_token: true,
      source: "oauth_callback",
    },
    created_at: new Date(), // allow-wall-clock: synthetic event envelope timestamp
  };
}

function failedEvent(connectorId: string): EventEnvelope {
  return {
    id: 2,
    tenant_id,
    channel: "connector.oauth",
    type: "connector.oauth.callback_failed",
    payload: { connector_id: connectorId, reason: "provider_error" },
    created_at: new Date(), // allow-wall-clock: synthetic event envelope timestamp
  };
}

async function insertCredential(connectorId: string): Promise<void> {
  await ctx.db.insert(credentials).values({
    tenant_id,
    connector_id: connectorId,
    environment: "dev",
    mode: "oauth2",
    ciphertext: PLACEHOLDER,
    iv: PLACEHOLDER,
    auth_tag: PLACEHOLDER,
  });
}

function buildCtx(
  connector_id: string,
  bridge: ElicitationBridge,
  draftRef: { current: DraftDocument },
): ToolContext {
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => draftRef.current,
    setDraft: async (next) => {
      draftRef.current = next;
    },
    abortSignal: new AbortController().signal,
    elicitationBridge: bridge,
  };
}

/** Wait until the tool has written the connector_oauth_states row — this
 *  proves `startAuthorizationCode` completed and the oob elicitation was
 *  issued, so the callback can now be simulated. */
async function awaitOAuthStateRow(connectorId: string): Promise<void> {
  await waitFor(
    async () => {
      const rows = await ctx.db
        .select({ id: connectorOauthStates.id })
        .from(connectorOauthStates)
        .where(eq(connectorOauthStates.connector_id, connectorId));
      return rows.length > 0;
    },
    { label: "connector_oauth_states row", sleepMs: 10, tries: 300 },
  );
}

describe("authenticate_oauth — URL-mode elicitation, happy path", () => {
  test("connector_authenticated checkpoint is marked ONLY after the credential lands", async () => {
    const connectorId = await makeOAuthConnector("aoe-happy");
    const draftRef: { current: DraftDocument } = {
      current: {
        mode: "connector_authoring",
        connector: { name: "aoe-happy", slug: "aoe-happy", driver: "http", environment: "dev" },
        workflow: { name: "", steps: [] },
      } as DraftDocument,
    };
    const bridge = makeOobBridge("accept");

    const running = authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    // The tool issued the oob elicitation and is now blocked in
    // `waitForOAuthCredential`. The checkpoint must NOT be set yet — the
    // previous optimistic marking is the bug this rework fixes.
    await awaitOAuthStateRow(connectorId);
    const checkpointsBefore = draftRef.current.state?.checkpoints?.connector_authenticated ?? null;
    expect(checkpointsBefore).toBeNull();

    // Simulate the OAuth callback: persist the credential then publish
    // the success event.
    await insertCredential(connectorId);
    await globalEmitter.dispatch(succeededEvent(connectorId));

    const result = await running;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { status: string };
      expect(data.status).toBe("authenticated");
    }
    // NOW the checkpoint is marked — and only now.
    const cp = draftRef.current.state?.checkpoints?.connector_authenticated;
    expect(cp).toBeDefined();
    expect(cp?.ok).toBe(true);
  });
});

describe("authenticate_oauth — URL-mode elicitation, provider failure", () => {
  test("a callback_failed event yields oauth_authorization_failed and no checkpoint", async () => {
    const connectorId = await makeOAuthConnector("aoe-fail");
    const draftRef: { current: DraftDocument } = {
      current: {
        mode: "connector_authoring",
        connector: { name: "aoe-fail", slug: "aoe-fail", driver: "http", environment: "dev" },
        workflow: { name: "", steps: [] },
      } as DraftDocument,
    };
    const bridge = makeOobBridge("accept");

    const running = authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    await awaitOAuthStateRow(connectorId);
    await globalEmitter.dispatch(failedEvent(connectorId));

    const result = await running;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("oauth_authorization_failed");
    }
    // The checkpoint stays unset — no credential was persisted.
    expect(draftRef.current.state?.checkpoints?.connector_authenticated ?? null).toBeNull();
  });
});

describe("authenticate_oauth — resume re-entry (idempotent wait)", () => {
  test("a pre-existing state row + already-landed credential resolves succeeded without a new URL", async () => {
    const connectorId = await makeOAuthConnector("aoe-resume");
    // Pre-seed a live state row — simulates a prior turn that already
    // handed the operator a URL (DB-pause resume, or a bridge retry).
    await ctx.db.insert(connectorOauthStates).values({
      tenant_id,
      connector_id: connectorId,
      state: "resume-state-token",
      code_verifier: "verifier",
      redirect_uri: "https://engine.test.example/v1/oauth/callback",
      expires_at: new Date(Date.now() + 10 * 60_000), // allow-wall-clock: OAuth state row real expiry
    });
    // The credential already landed — waitForOAuthCredential is idempotent.
    await insertCredential(connectorId);

    const draftRef: { current: DraftDocument } = {
      current: {
        mode: "connector_authoring",
        connector: { name: "aoe-resume", slug: "aoe-resume", driver: "http", environment: "dev" },
        workflow: { name: "", steps: [] },
      } as DraftDocument,
    };
    const result = await authenticateOAuthTool.execute(
      buildCtx(connectorId, makeOobBridge("accept"), draftRef),
      { connector_id: connectorId },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { status: string }).status).toBe("authenticated");
    }
    // Only ONE state row — the resume path did not mint a second.
    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(1);
    expect(draftRef.current.state?.checkpoints?.connector_authenticated?.ok).toBe(true);
  });
});

describe("authenticate_oauth — RBAC gate is not bypassed by the elicitation bridge", () => {
  test("a principal lacking connector:oauth is denied even with an elicitation-capable bridge", async () => {
    const connectorId = await makeOAuthConnector("aoe-rbac");

    // A user principal with no role and no grants: `can()` resolves no
    // role_id for this id, so `connector:oauth` denies.
    const principal: ResolvedPrincipal = {
      kind: "user",
      id: "00000000-0000-0000-0000-0000000000aa",
      tenant_id,
      roles: [],
      // biome-ignore lint/suspicious/noExplicitAny: minimal principal stub for an RBAC-deny test
    } as any;

    const registry = buildRegistry([staticToolProvider, conversationToolProvider]);

    // The dispatcher runs the descriptor-declared `connector:oauth` gate
    // BEFORE `authenticate_oauth.execute` — so the elicitation bridge,
    // which lives on the conversation ctx the executor would receive, is
    // never reached. Presence of a bridge cannot bypass the permission
    // gate. We pass a bridge-carrying conversationCtx to make that
    // explicit; the deny short-circuits before it is consumed.
    const draftRef: { current: DraftDocument } = {
      current: {
        mode: "connector_authoring",
        connector: { name: "aoe-rbac", slug: "aoe-rbac", driver: "http", environment: "dev" },
        workflow: { name: "", steps: [] },
      } as DraftDocument,
    };
    const conversationCtx = buildCtx(connectorId, makeOobBridge("accept"), draftRef);

    const envelope = await dispatchTool(
      { registry, db: ctx.db, principal, conversationCtx },
      { surface: "chat", name: "authenticate_oauth", args: { connector_id: connectorId } },
    );

    expect(envelope.status).toBe("error");
    if (envelope.status === "error") {
      expect(envelope.error_code).toBe("policy_denied");
    }
    // The gate fired before the executor ran — no OAuth state row minted.
    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(0);
  });
});
