import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  type MockOAuthServer,
  startMockOAuthServer,
} from "../../credentials/oauth2/tests/mock-server.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  connectorOauthStates,
  connectors,
  conversationElicitations,
  conversations,
  credentials,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import { startListener, stopListener } from "../../pubsub/listener.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../../tools/index.ts";
import { buildRegistry } from "../../tools/registry.ts";
import { makeTestPrincipal } from "../../tools/tests/_helpers.ts";
import type { ElicitationBridge, ElicitationResult } from "../elicitation-bridge.ts";
import { ElicitationUnsupportedError } from "../elicitation-bridge.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import {
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
} from "../tools/error-codes.ts";
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
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-aoauth-elicit-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/aoauth-elicit", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
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

function makeOobBridge(action: "accept" | "decline" = "accept"): ElicitationBridge {
  const fn = async (): Promise<ElicitationResult> => ({ action });
  return {
    capabilities: { form: true, oob: true },
    elicitForm: fn,
    elicitOob: fn,
  } as unknown as ElicitationBridge;
}

function makeOobThrowingBridge(error: Error): ElicitationBridge {
  const fn = async (): Promise<ElicitationResult> => {
    throw error;
  };
  return {
    capabilities: { form: true, oob: true },
    elicitForm: async (): Promise<ElicitationResult> => ({ action: "accept" }),
    elicitOob: fn,
  } as unknown as ElicitationBridge;
}

function makeFormBridge(result: ElicitationResult): ElicitationBridge {
  return {
    capabilities: { form: true, oob: false },
    elicitForm: async (): Promise<ElicitationResult> => result,
    elicitOob: async (): Promise<ElicitationResult> => ({ action: "accept" }),
  } as unknown as ElicitationBridge;
}

function makeFormThrowingBridge(error: Error): ElicitationBridge {
  return {
    capabilities: { form: true, oob: false },
    elicitForm: async (): Promise<ElicitationResult> => {
      throw error;
    },
    elicitOob: async (): Promise<ElicitationResult> => ({ action: "accept" }),
  } as unknown as ElicitationBridge;
}

async function readElicitations(convId: string) {
  return ctx.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, convId));
}

async function readResolveAudit(elicitationId: string, action: string) {
  const [row] = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_id, elicitationId),
        eq(auditLog.action, action),
      ),
    );
  return row;
}

function makeDraftRef(slug: string): { current: DraftDocument } {
  return {
    current: {
      mode: "connector_authoring",
      connector: { name: slug, slug, driver: "http", environment: "dev" },
      workflow: { name: "", steps: [] },
    } as DraftDocument,
  };
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
    payload: { connector_id: connectorId, connector_slug: "oauth", reason: "provider_error" },
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

async function awaitHandlerRegistered(beforeCount: number): Promise<void> {
  await waitFor(() => globalEmitter.listenerCount("connector.oauth") > beforeCount, {
    label: "connector.oauth handler registered",
    sleepMs: 5,
    tries: 400,
  });
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
    const listenersBefore = globalEmitter.listenerCount("connector.oauth");

    const running = authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    await awaitOAuthStateRow(connectorId);
    const checkpointsBefore = draftRef.current.state?.checkpoints?.connector_authenticated ?? null;
    expect(checkpointsBefore).toBeNull();

    await awaitHandlerRegistered(listenersBefore);
    await insertCredential(connectorId);
    await globalEmitter.dispatch(succeededEvent(connectorId));

    const result = await running;
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { status: string };
      expect(data.status).toBe("authenticated");
    }
    const cp = draftRef.current.state?.checkpoints?.connector_authenticated;
    expect(cp).toBeDefined();
    expect(cp?.ok).toBe(true);

    const elicitation = (await readElicitations(conversation_id)).find((r) =>
      r.summary.includes("aoe-happy"),
    );
    expect(elicitation).toBeDefined();
    const audit = await readResolveAudit(elicitation!.id, "approval.approved");
    expect(audit).toBeDefined();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.surface).toBe("mcp_elicitation");
    expect(meta.elicitation_transport).toBe("succeeded");
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
    const listenersBefore = globalEmitter.listenerCount("connector.oauth");

    const running = authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    await awaitOAuthStateRow(connectorId);
    await awaitHandlerRegistered(listenersBefore);
    await globalEmitter.dispatch(failedEvent(connectorId));

    const result = await running;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(OAUTH_AUTHORIZATION_FAILED);
    }
    expect(draftRef.current.state?.checkpoints?.connector_authenticated ?? null).toBeNull();
  });
});

describe("authenticate_oauth — resume re-entry (idempotent wait)", () => {
  test("a pre-existing state row + already-landed credential resolves succeeded without a new URL", async () => {
    const connectorId = await makeOAuthConnector("aoe-resume");
    await ctx.db.insert(connectorOauthStates).values({
      tenant_id,
      connector_id: connectorId,
      state: "resume-state-token",
      code_verifier: "verifier",
      redirect_uri: "https://engine.test.example/v1/oauth/callback",
      expires_at: new Date(Date.now() + 10 * 60_000), // allow-wall-clock: OAuth state row real expiry
    });
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
    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(1);
    expect(draftRef.current.state?.checkpoints?.connector_authenticated?.ok).toBe(true);
  });
});

describe("authenticate_oauth — single dance per connector", () => {
  test("a second authenticate_oauth call with a live state row resumes it, no second state row", async () => {
    const connectorId = await makeOAuthConnector("aoe-single-dance");
    await ctx.db.insert(connectorOauthStates).values({
      tenant_id,
      connector_id: connectorId,
      state: "single-dance-state-token",
      code_verifier: "verifier",
      redirect_uri: "https://engine.test.example/v1/oauth/callback",
      expires_at: new Date(Date.now() + 10 * 60_000), // allow-wall-clock: OAuth state row real expiry
    });
    await insertCredential(connectorId);

    const draftRef: { current: DraftDocument } = {
      current: {
        mode: "connector_authoring",
        connector: {
          name: "aoe-single-dance",
          slug: "aoe-single-dance",
          driver: "http",
          environment: "dev",
        },
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

    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id, state: connectorOauthStates.state })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0]!.state).toBe("single-dance-state-token");
  });
});

describe("authenticate_oauth — RBAC gate is not bypassed by the elicitation bridge", () => {
  test("a principal lacking connector:oauth is denied even with an elicitation-capable bridge", async () => {
    const connectorId = await makeOAuthConnector("aoe-rbac");

    const principal = makeTestPrincipal({
      id: "00000000-0000-0000-0000-0000000000aa",
      tenant_id,
      roles: [],
    });

    const registry = buildRegistry([staticToolProvider, conversationToolProvider]);

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
    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(0);
  });
});

describe("authenticate_oauth — form-mode elicitation", () => {
  test("an accepted form whose acknowledged box is false is treated as a decline", async () => {
    const connectorId = await makeOAuthConnector("aoe-form-unack");
    const draftRef = makeDraftRef("aoe-form-unack");
    const bridge = makeFormBridge({ action: "accept", content: { acknowledged: false } });

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe(OAUTH_AUTHORIZATION_DECLINED);
    }
    const rows = await readElicitations(conversation_id);
    const row = rows.find((r) => r.tool_call_id == null && r.summary.includes("aoe-form-unack"));
    expect(row?.status).toBe("cancelled");
    expect(row?.decision_reason).toBe(OAUTH_AUTHORIZATION_DECLINED);
    expect(draftRef.current.state?.checkpoints?.connector_authenticated ?? null).toBeNull();
  });

  test("an explicit form decline yields oauth_authorization_declined", async () => {
    const connectorId = await makeOAuthConnector("aoe-form-decline");
    const draftRef = makeDraftRef("aoe-form-decline");
    const bridge = makeFormBridge({ action: "decline" });

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe(OAUTH_AUTHORIZATION_DECLINED);
    expect(draftRef.current.state?.checkpoints?.connector_authenticated ?? null).toBeNull();
  });
});

describe("authenticate_oauth — elicitation transport failure", () => {
  test("an oob transport failure yields a structured error and keeps the state row live", async () => {
    const connectorId = await makeOAuthConnector("aoe-oob-transport");
    const draftRef = makeDraftRef("aoe-oob-transport");
    const bridge = makeOobThrowingBridge(new Error("client disconnected"));

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe(OAUTH_ELICITATION_TRANSPORT_FAILED);
    const stateRows = await ctx.db
      .select({ id: connectorOauthStates.id })
      .from(connectorOauthStates)
      .where(eq(connectorOauthStates.connector_id, connectorId));
    expect(stateRows).toHaveLength(1);

    const elicitation = (await readElicitations(conversation_id)).find((r) =>
      r.summary.includes("aoe-oob-transport"),
    );
    expect(elicitation).toBeDefined();
    const audit = await readResolveAudit(elicitation!.id, "approval.rejected");
    expect(audit).toBeDefined();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.surface).toBe("mcp_elicitation");
    expect(meta.elicitation_transport).toBe("failed");
  });

  test("a form transport failure yields a structured error", async () => {
    const connectorId = await makeOAuthConnector("aoe-form-transport");
    const draftRef = makeDraftRef("aoe-form-transport");
    const bridge = makeFormThrowingBridge(new Error("client disconnected"));

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe(OAUTH_ELICITATION_TRANSPORT_FAILED);
  });
});

describe("authenticate_oauth — ElicitationUnsupportedError demote to portal", () => {
  test("oob: capability raced away mid-call → demote the SAME row, no second elicitation", async () => {
    const connectorId = await makeOAuthConnector("aoe-oob-demote");
    const draftRef = makeDraftRef("aoe-oob-demote");
    const bridge = makeOobThrowingBridge(new ElicitationUnsupportedError("oob"));

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_confirm");
    }

    const rows = (await readElicitations(conversation_id)).filter((r) =>
      r.summary.includes("aoe-oob-demote"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol_native).toBe(false);
    expect(rows[0]!.status).toBe("pending");
    if (result.ok) {
      expect(result.pause?.elicitation_id).toBe(rows[0]!.id);
      expect((result.data as { elicitation_id: string }).elicitation_id).toBe(rows[0]!.id);
    }

    const demoteAudit = await readResolveAudit(rows[0]!.id, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    expect(demoteAudit!.resource_id).toBe(rows[0]!.id);
    expect(demoteAudit!.tenant_id).toBe(tenant_id);
  });

  test("form: capability raced away mid-call → demote the SAME row, no second elicitation", async () => {
    const connectorId = await makeOAuthConnector("aoe-form-demote");
    const draftRef = makeDraftRef("aoe-form-demote");
    const bridge = makeFormThrowingBridge(new ElicitationUnsupportedError("form"));

    const result = await authenticateOAuthTool.execute(buildCtx(connectorId, bridge, draftRef), {
      connector_id: connectorId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pause).toBeDefined();
      expect(result.pause?.tool_name).toBe("ask_user_confirm");
    }

    const rows = (await readElicitations(conversation_id)).filter((r) =>
      r.summary.includes("aoe-form-demote"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol_native).toBe(false);
    expect(rows[0]!.status).toBe("pending");
    if (result.ok) {
      expect(result.pause?.elicitation_id).toBe(rows[0]!.id);
      expect((result.data as { elicitation_id: string }).elicitation_id).toBe(rows[0]!.id);
    }

    const demoteAudit = await readResolveAudit(rows[0]!.id, "elicitation.demoted_to_portal");
    expect(demoteAudit).toBeDefined();
    expect(demoteAudit!.resource_id).toBe(rows[0]!.id);
    expect(demoteAudit!.tenant_id).toBe(tenant_id);
  });
});
