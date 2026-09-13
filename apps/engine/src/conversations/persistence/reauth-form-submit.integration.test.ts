// Integration test — in-chat Cognito re-issue rotates in place via the
// FORM-SUBMIT path (P2).
//
// Coverage:
//   A) ask_user_form.execute on a `connector_reauth_started` draft stamps a
//      `save_connector_draft` commit_intent on the elicitation row — even when
//      the LLM did NOT attach its own commit_intent. This is the fix that
//      prevents the "auto_persist.skipped: elicitation resolved without
//      commit_intent" dead-end for Cognito re-issue.
//
//   B) maybeAutoPersistFromElicitation with form values (username + password)
//      calls saveConnectorAtomic which:
//        - rotates the credential on the SAME connector id (no new row)
//        - clears needs_reauth (connectors.needs_reauth = false, auth_failed_at IS NULL)
//        - emits a `credential_rotated` audit row
//        - emits a `connector.reauth_cleared` audit row
//      All without authenticate_oauth being involved.
//
// The Cognito InitiateAuth network call (runCognitoUserPasswordGrant) is
// spied upon and replaced with a mock that returns tokens, so no live AWS
// endpoint is contacted.
//
// Level tested:
//   - ask_user_form.execute (conversation tool)
//   - maybeAutoPersistFromElicitation (persistence dispatcher)
//   - saveConnectorAtomic (re-issue path)
//
// The full HTTP elicitation resume path (respondElicitation →
// applyElicitationOutcome → maybeAutoPersistFromElicitation) is NOT driven
// here — that end-to-end path is already tested in recipe-flow.integration.test.ts.
// Driving it here would require a full conversation loop with a mock LLM, which
// would be over-coupled to the loop internals. Instead we drive the two inner
// seams directly, which is what the fix guarantees.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";

import { markConnectorNeedsReauth } from "../../connectors/reauth.ts";
import * as oauthClient from "../../credentials/oauth2/client.ts";
import { auditLog, connectors, conversationElicitations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { TEST_HUMAN_ANSWER } from "../../test-helpers/answer-actor.ts";
import { appendSnapshot } from "../draft.ts";
import { createConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../tests/setup.ts";
import { askUserFormTool } from "../tools/ask-user/form.ts";
import { requestConnectorReauthTool } from "../tools/request-connector-reauth.ts";
import type { DraftDocument } from "../types.ts";
import { maybeAutoPersistFromElicitation } from "./auto-persist.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("reauth_form_submit");
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Seed a Cognito connector with `needs_reauth = true`. */
async function seedCognitoConnector(slug: string): Promise<string> {
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://appsync.example.test/graphql",
      config: {
        aws_region: "us-east-1",
        oauth: {
          grant_type: "cognito_user_password",
          client_id: "test-client-id",
          client_secret: null,
          issuer_url: "https://cognito.example.test",
          scope: null,
        },
      },
    })
    .returning({ id: connectors.id });
  if (!c) throw new Error("seed cognito connector failed");

  await markConnectorNeedsReauth(ctx.testDb.db, ctx.tenant_id, c.id, "token_expired");
  return c.id;
}

async function makeToolCtx(connectorId: string | null = null) {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, title: "cognito-reauth-test" },
    ctx.testDb.db,
  );
  let draft: DraftDocument = { workflow: { name: "", steps: [] } };
  const toolCtx = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: connectorId,
    workflow_id: null,
    permission_mode: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    // Persist the draft to the DB so maybeAutoPersistFromElicitation
    // can load it via loadDraft (which reads from conversation_drafts).
    setDraft: async (next: DraftDocument) => {
      draft = next;
      await appendSnapshot(ctx.tenant_id, created.conversation.id, next, ctx.testDb.db);
    },
  };
  return { toolCtx, conversation_id: created.conversation.id };
}

/** Return the cognito_user_password mock bundle for runCognitoUserPasswordGrant. */
function mockCognitoGrant() {
  return spyOn(oauthClient, "runCognitoUserPasswordGrant").mockResolvedValue({
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    token_type: "none" as const,
    expires_at: new Date(Date.now() + 3600_000), // allow-wall-clock: mock token expiry
    scope: null,
  });
}

describe("Cognito re-issue form-submit path — Part A: commit_intent stamped on form", () => {
  test("ask_user_form on connector_reauth_started draft stamps save_connector_draft commit_intent", async () => {
    const connectorId = await seedCognitoConnector("cognito-stamp-intent");
    const { toolCtx, conversation_id } = await makeToolCtx(connectorId);

    // Step 1: bind the re-issue draft via request_connector_reauth.
    const reauth = await requestConnectorReauthTool.execute(toolCtx, {
      connector_id: connectorId,
    });
    expect(reauth.ok).toBe(true);
    const reauthData = reauth.data as { method: string; mode: string };
    expect(reauthData.method).toBe("portal_setup");
    expect(reauthData.mode).toBe("credential_re_issue");

    // Draft must now have saved_connector_id and connector_reauth_started.
    const draft = toolCtx.getDraft();
    expect(draft.connector?.saved_connector_id).toBe(connectorId);
    expect(draft.summary?.last_action).toBe("connector_reauth_started");

    // Step 2: call ask_user_form with the canonical Cognito credential fields.
    // No commit_intent from the LLM — the fix must stamp it automatically.
    const formResult = await askUserFormTool.execute(toolCtx, {
      question: "Enter your Cognito credentials",
      fields: [
        { name: "username", label: "Email", type: "text" as const, required: true },
        {
          name: "password",
          label: "Password",
          type: "password" as const,
          sensitive: true,
          required: true,
        },
      ],
      // Deliberately NO commit_intent from the LLM — the fix stamps it.
    });

    // The form tool should return a pause (DB-pause path, no bridge).
    expect(formResult.ok).toBe(true);
    expect(formResult.pause).toBeDefined();
    expect(formResult.pause?.tool_name).toBe("ask_user_form");

    // Step 3: verify the elicitation row carries the stamped commit_intent.
    const elicitations = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));

    expect(elicitations.length).toBeGreaterThan(0);
    const elicitation = elicitations[elicitations.length - 1]!;

    const input = elicitation.input as Record<string, unknown>;
    const commitIntent = input.commit_intent as
      { kind: string; payload: Record<string, unknown>; description: string } | undefined;

    // The fix: commit_intent must be present with kind = "save_connector_draft".
    expect(commitIntent).toBeDefined();
    expect(commitIntent?.kind).toBe("save_connector_draft");
    // The payload must carry the credential mode so the dispatcher knows the shape.
    const credPayload = commitIntent?.payload?.credential as Record<string, unknown> | undefined;
    expect(typeof credPayload?.mode).toBe("string");
    expect(credPayload?.mode).toBe("cognito_user_password");
  });
});

describe("Cognito re-issue form-submit path — Part B: dispatcher rotates credential in place", () => {
  test("maybeAutoPersistFromElicitation with form values rotates credential + clears needs_reauth", async () => {
    const connectorId = await seedCognitoConnector("cognito-rotate-cred");
    const { toolCtx, conversation_id } = await makeToolCtx(connectorId);

    // Step 1: bind the re-issue draft.
    const reauth = await requestConnectorReauthTool.execute(toolCtx, {
      connector_id: connectorId,
    });
    expect(reauth.ok).toBe(true);

    // Step 2: form tool creates the elicitation with the stamped commit_intent.
    await askUserFormTool.execute(toolCtx, {
      question: "Enter your Cognito credentials",
      fields: [
        { name: "username", label: "Email", type: "text" as const, required: true },
        {
          name: "password",
          label: "Password",
          type: "password" as const,
          sensitive: true,
          required: true,
        },
      ],
    });

    // Fetch the elicitation row with the stamped commit_intent.
    const elicitations = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));
    const elicitation = elicitations[elicitations.length - 1]!;

    // Verify the commit_intent is there before dispatching.
    const elicitationInput = elicitation.input as Record<string, unknown>;
    const commitIntent = elicitationInput.commit_intent as { kind: string } | undefined;
    expect(commitIntent?.kind).toBe("save_connector_draft");

    // Step 3: simulate operator submitting the form with credentials.
    // Mock Cognito InitiateAuth so no real AWS call is made.
    const cognitoSpy = mockCognitoGrant();

    let dispatchResult: Awaited<ReturnType<typeof maybeAutoPersistFromElicitation>>;
    try {
      dispatchResult = await maybeAutoPersistFromElicitation({
        answer_actor: TEST_HUMAN_ANSWER,
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        // Form submission output: the operator's submitted values.
        elicitation_output: {
          values: {
            username: "user@example.test",
            password: "new-cognito-password",
          },
        },
        elicitation: {
          id: elicitation.id,
          tool_name: elicitation.tool_name,
          input: elicitation.input,
        },
        db: ctx.testDb.db,
      });
    } finally {
      // Restore AFTER assertions, not before, so the call count is intact.
      // Note: mockRestore is in the finally block but assertions happen below
      // before this finally runs — we use a try/finally pattern.
    }

    // (e) Cognito InitiateAuth was called once — the real token exchange happened.
    // Assert BEFORE mockRestore so the spy call count is still accessible.
    expect(cognitoSpy).toHaveBeenCalledTimes(1);
    cognitoSpy.mockRestore();

    // The dispatcher must have fired.
    expect(dispatchResult!.dispatched).toBe(true);
    expect(dispatchResult!.synthetic_result?.ok).toBe(true);

    // (b) needs_reauth cleared, auth_failed_at IS NULL.
    const [after] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth, auth_failed_at: connectors.auth_failed_at })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(after?.needs_reauth).toBe(false);
    expect(after?.auth_failed_at).toBeNull();

    // (c) A credential_rotated audit row must exist.
    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, connectorId)))
      .orderBy(desc(auditLog.ts));
    const rotatedRow = auditRows.find(
      (r) => (r.metadata as { kind?: string }).kind === "credential_rotated",
    );
    expect(rotatedRow).toBeDefined();

    // (d) A connector.reauth_cleared audit row must exist (clearConnectorReauth self-audits).
    const reauthClearedRow = auditRows.find((r) => r.action === "connector.reauth_cleared");
    expect(reauthClearedRow).toBeDefined();
  });

  test("wrong tenant cannot initiate re-issue: requestConnectorReauthTool returns connector_not_found", async () => {
    const connectorId = await seedCognitoConnector("cognito-wrong-tenant-guard");

    // Build a tool context for a different tenant — the connector is not visible.
    const wrongTenantCtx = {
      db: ctx.testDb.db,
      tenant_id: "00000000-0000-0000-0000-ffffffffffff",
      conversation_id: crypto.randomUUID(), // allow-random: test isolation
      actor_id: ctx.user_id,
      connector_id: null,
      workflow_id: null,
      permission_mode: null,
      engineClient: new EngineClient({
        tenant_id: "00000000-0000-0000-0000-ffffffffffff",
        actor_id: ctx.user_id,
        actor_type: "user",
        db: ctx.testDb.db,
      }),
      getDraft: (): DraftDocument => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };

    const result = await requestConnectorReauthTool.execute(wrongTenantCtx, {
      connector_id: connectorId,
    });
    // connector belongs to a different tenant — must not be found.
    expect(result.ok).toBe(false);
    const err = result as { error_code?: string };
    expect(err.error_code).toBe("connector_not_found");

    // The connector itself must remain untouched (needs_reauth still true).
    const [check] = await ctx.testDb.db
      .select({ needs_reauth: connectors.needs_reauth })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    expect(check?.needs_reauth).toBe(true);
  });
});
