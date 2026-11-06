import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectorOauthStates } from "../../db/schema/index.ts";
import { dispatchTool } from "../../tools/dispatcher.ts";
import { conversationToolProvider, staticToolProvider } from "../../tools/index.ts";
import { buildRegistry } from "../../tools/registry.ts";
import { makeTestPrincipal } from "../../tools/tests/_helpers.ts";
import type { ElicitationBridge, ElicitationResult } from "../elicitation-bridge.ts";
import { ElicitationUnsupportedError } from "../elicitation-bridge.ts";
import { authenticateOAuthTool } from "../tools/authenticate-oauth.ts";
import {
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
} from "../tools/error-codes.ts";
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

function makeDraftRef(slug: string): { current: DraftDocument } {
  return {
    current: {
      mode: "connector_authoring",
      connector: { name: slug, slug, driver: "http", environment: "dev" },
      workflow: { name: "", steps: [] },
    } as DraftDocument,
  };
}

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
