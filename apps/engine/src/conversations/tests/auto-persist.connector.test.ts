import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  conversationMessages,
  conversations,
  conversationToolCalls,
  credentials,
} from "../../db/schema/index.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist/index.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import type { DraftDocument } from "../types.ts";
import {
  createCarrierElicitation,
  ctx,
  tenant_id,
  useAutoPersistSetup,
} from "./auto-persist-fixtures.ts";

useAutoPersistSetup();

function readyDraft(slug: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: slug,
      slug,
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.example.test",
    },
    workflow: { name: "", steps: [] },
  };
  const validated = withConnectorValidation(
    withConnectorInspection(baseDraft),
    {
      ...baseDraft.connector,
      validation: validateConnectorDraft(baseDraft.connector ?? null, []),
    },
    true,
    "Connector draft validated.",
  );
  return withConnectorProbe(
    validated,
    {
      ...validated.connector,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/health",
        environment: "dev",
        status_code: 200,
        summary: "ok",
      },
    },
    true,
    "ok",
  );
}

async function seedConversationWithDraft(slug: string): Promise<{
  conversation_id: string;
  draft: DraftDocument;
}> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  const draft = readyDraft(slug);
  await appendSnapshot(tenant_id, conv!.id, draft, ctx.db);
  return { conversation_id: conv!.id, draft };
}

describe("auto-persist on confirmation — save_connector_draft", () => {
  test("ask_user_form submit with commit_intent persists connector + credential atomically", async () => {
    const { conversation_id } = await seedConversationWithDraft("ap-bearer");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Bearer token?",
        fields: [{ name: "token", label: "Token", type: "password", sensitive: true }],
        commit_intent: {
          kind: "save_connector_draft",
          payload: {
            credential: { mode: "bearer" },
            environment: "dev",
          },
          description: "Save the connector with this bearer token",
        },
      },
      output: { values: { token: "operator-secret-bearer" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { values: { token: "operator-secret-bearer" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "ap-bearer")));
    expect(conn).toHaveLength(1);

    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("bearer");

    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant_id));
    const autoPersistRows = audit.filter((r) =>
      (r.reason ?? "").includes("auto_persist_on_confirmation"),
    );
    expect(autoPersistRows.length).toBeGreaterThanOrEqual(1);
    const harnessAudit = autoPersistRows.find(
      (r) =>
        typeof r.metadata === "object" &&
        r.metadata !== null &&
        (r.metadata as Record<string, unknown>).commit_intent_kind === "save_connector_draft",
    );
    expect(harnessAudit).toBeDefined();

    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);

    const msgs = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversation_id));
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const toolMsgContent = toolMsg!.content as Record<string, unknown>;
    expect(toolMsgContent._harness_auto_persist).toBe(true);
  });

  test("ask_user_form submit with oauth2 BYO commit_intent persists connector + writes client_id/client_secret to config.oauth (gmail flow)", async () => {
    _resetDraftCredentialCacheForTests();

    const slug = "google-gmail";
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const oauth2Draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "Gmail API",
        slug,
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://gmail.googleapis.com/gmail/v1",
        template_slug: "google-gmail",
        config: { oauth: { grant_type: "authorization_code" } },
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(oauth2Draft),
      {
        ...oauth2Draft.connector,
        validation: validateConnectorDraft(oauth2Draft.connector ?? null, []),
      },
      true,
      "Connector draft validated.",
    );
    const draft = withConnectorProbe(
      validated,
      {
        ...validated.connector,
        latest_probe: {
          ok: true,
          method: "GET",
          path: "/",
          environment: "dev",
          status_code: 200,
          summary: "ok",
        },
      },
      true,
      "ok",
    );
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);

    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide your Google OAuth2 client credentials.",
        fields: [
          { name: "client_id", label: "OAuth Client ID", type: "text", sensitive: false },
          {
            name: "client_secret",
            label: "OAuth Client Secret",
            type: "password",
            sensitive: true,
          },
        ],
        commit_intent: {
          kind: "save_connector_draft",
          payload: {
            credential: {
              mode: "oauth2",
              client_id: "{{client_id}}",
              client_secret: "{{client_secret}}",
            },
            environment: "dev",
          },
          description: "Persist Gmail OAuth2 connector with BYO client credentials",
        },
      },
      output: {
        values: { client_id: "my-google-client", client_secret: "GOCSPX-real" },
      },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: {
        values: { client_id: "my-google-client", client_secret: "GOCSPX-real" },
      },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
    expect(conn).toHaveLength(1);

    const savedConfig = (conn[0]!.config ?? {}) as {
      oauth?: { client_id?: string; client_secret?: string };
    };
    expect(savedConfig.oauth?.client_id).toBe("my-google-client");
    expect(savedConfig.oauth?.client_secret).toBe("GOCSPX-real");

    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(0);

    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant_id));
    const approval = audit.find(
      (r) =>
        r.action === "approval.approved" &&
        r.resource_type === "conversation_elicitation" &&
        r.resource_id === elicitation.id,
    );
    expect(approval).toBeDefined();
    expect(approval!.result).toBe("success");
    const approvalMeta = (approval!.metadata ?? {}) as Record<string, unknown>;
    expect(approvalMeta.commit_intent_kind).toBe("save_connector_draft");
    expect(approvalMeta.tool).toBe("save_connector_draft");
    expect(approvalMeta.ok).toBe(true);
    const auditAsJson = JSON.stringify(audit);
    expect(auditAsJson).not.toContain("GOCSPX-real");

    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);

    expect(getDraftCredential(conversation_id)).toBeNull();

    const liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
    const checkpoints = liveDraft.summary?.checkpoints ?? [];
    const authCheckpoint = checkpoints.find((cp) => cp.key === "connector_authenticated");
    expect(authCheckpoint?.status === "fresh").toBe(false);
    const persistedCheckpoint = checkpoints.find((cp) => cp.key === "connector_persisted");
    expect(persistedCheckpoint?.status).toBe("fresh");
  });
});

describe("auto-persist on confirmation — save_connector_draft basic-auth", () => {
  test("ask_user_form with canonical username + password fields persists connector + basic credential atomically", async () => {
    _resetDraftCredentialCacheForTests();

    const slug = "ap-basic-jira";
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;

    const basicDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "Jira Cloud",
        slug,
        driver: "http",
        environment: "dev",
        auth_type: "basic",
        base_url: "https://example.atlassian.net/rest/api/3",
      },
      workflow: { name: "", steps: [] },
    };
    const validated = withConnectorValidation(
      withConnectorInspection(basicDraft),
      {
        ...basicDraft.connector,
        validation: validateConnectorDraft(basicDraft.connector ?? null, []),
      },
      true,
      "Connector draft validated.",
    );
    const draft = withConnectorProbe(
      validated,
      {
        ...validated.connector,
        latest_probe: {
          ok: true,
          method: "GET",
          path: "/myself",
          environment: "dev",
          status_code: 200,
          summary: "ok",
        },
      },
      true,
      "ok",
    );
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);

    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide your Jira credentials (email + API token).",
        fields: [
          { name: "username", label: "Email address", type: "text", sensitive: false },
          { name: "password", label: "API token", type: "password", sensitive: true },
        ],
        commit_intent: {
          kind: "save_connector_draft",
          payload: {
            credential: { mode: "basic" },
            environment: "dev",
          },
          description: "Save the Jira connector with basic-auth credentials",
        },
      },
      output: { values: { username: "operator@example.com", password: "ATATT3xFfGF0-test-token" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: {
        values: { username: "operator@example.com", password: "ATATT3xFfGF0-test-token" },
      },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("save_connector_draft");
    expect(dispatch.synthetic_result?.source).toBe("harness_auto_persist");

    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
    expect(conn).toHaveLength(1);

    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("basic");

    const audit = await ctx.db.select().from(auditLog).where(eq(auditLog.tenant_id, tenant_id));
    const autoPersistRows = audit.filter((r) =>
      (r.reason ?? "").includes("auto_persist_on_confirmation"),
    );
    expect(autoPersistRows.length).toBeGreaterThanOrEqual(1);
    const harnessAudit = autoPersistRows.find(
      (r) =>
        typeof r.metadata === "object" &&
        r.metadata !== null &&
        (r.metadata as Record<string, unknown>).commit_intent_kind === "save_connector_draft",
    );
    expect(harnessAudit).toBeDefined();

    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);
    const callData = callOutput.data as Record<string, unknown> | undefined;
    expect(callData?.credential_persisted).toBe(true);

    expect(getDraftCredential(conversation_id)).toBeNull();

    const liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
    const checkpoints = liveDraft.summary?.checkpoints ?? [];
    const persistedCheckpoint = checkpoints.find((cp) => cp.key === "connector_persisted");
    expect(persistedCheckpoint?.status).toBe("fresh");
  });
});

describe("auto-persist on confirmation — oauth_completed credential gate", () => {
  test("confirming the OAuth prompt with NO minted credential returns authenticated:false (not a false success)", async () => {
    const { conversation_id } = await seedConversationWithDraft("ap-oauth-nocred");
    const connectorId = "11111111-1111-4111-8111-111111111111";
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        question: "Have you completed the authorization in your browser?",
        commit_intent: {
          kind: "oauth_completed",
          payload: { connector_id: connectorId, connector_slug: "linkedin" },
          description: "Resume work that was blocked on linkedin: the credential is now active.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("oauth_not_completed");
    const data = dispatch.synthetic_result?.data as Record<string, unknown> | undefined;
    expect(data?.authenticated).toBe(false);
    expect(dispatch.synthetic_result?.next_best_actions).toContain("authenticate_oauth");
  });

  test("confirming credential re-issue with no saved credential returns reconnected:false", async () => {
    const { conversation_id } = await seedConversationWithDraft("ap-reauth-nocred");
    const connectorId = "22222222-2222-4222-8222-222222222222";
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        kind: "external_write",
        question: "Complete the secure credential replacement.",
        commit_intent: {
          kind: "credential_reissue_completed",
          payload: { connector_id: connectorId, connector_slug: "notion" },
          description: "Resume work after the replacement credential is active.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      answer_actor: TEST_HUMAN_ANSWER,
      tenant_id,
      conversation_id,
      actor_id: null,
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("credential_reissue_not_completed");
    const data = dispatch.synthetic_result?.data as Record<string, unknown> | undefined;
    expect(data?.reconnected).toBe(false);
    expect(dispatch.synthetic_result?.next_best_actions).toContain("request_connector_reauth");
  });
});
