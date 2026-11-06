import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectorOauthStates, credentials } from "../../db/schema/index.ts";
import { globalEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import { OAUTH_AUTHORIZATION_FAILED } from "../tools/error-codes.ts";
import type { DraftDocument } from "../types.ts";
import {
  buildCtx,
  conversation_id,
  ctx,
  makeOAuthConnector,
  makeOobBridge,
  readElicitations,
  readResolveAudit,
  tenant_id,
  useAuthenticateOauthElicitationSetup,
} from "./authenticate-oauth-elicitation-fixtures.ts";

useAuthenticateOauthElicitationSetup();

const PLACEHOLDER = Buffer.from([0x01]);

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
