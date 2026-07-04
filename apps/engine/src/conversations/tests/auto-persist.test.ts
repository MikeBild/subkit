// Auto-persist on confirmation.
//
// When the LLM emits `ask_user_form` or `ask_user_confirm` with a
// `commit_intent`, the harness applies the proposed write atomically
// after `respondElicitation` resolves the carrier. The LLM's next
// turn sees a synthetic tool result with `source: "harness_auto_persist"`,
// so the loop never has to call `save_connector_draft` itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  credentials,
  tenants,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { maybeAutoPersistFromElicitation } from "../persistence/auto-persist.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
} from "../persistence/draft-credential-cache.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("auto_persist");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-ap", display_name: "T-AP" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

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

async function createCarrierElicitation(p: {
  conversation_id: string;
  tool_name: "ask_user_form" | "ask_user_confirm";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}): Promise<{ id: string; tool_name: string; input: unknown }> {
  const [row] = await ctx.db
    .insert(conversationElicitations)
    .values({
      tenant_id,
      conversation_id: p.conversation_id,
      tool_name: p.tool_name,
      summary: "test carrier",
      input: p.input,
      output: p.output,
      status: "resolved",
    })
    .returning();
  if (!row) throw new Error("failed to insert elicitation");
  return { id: row.id, tool_name: row.tool_name, input: row.input };
}

async function seedRenderWorkflow(
  slug = "render-upload-slides-autopersist",
): Promise<{ workflow_id: string; slug: string }> {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id,
      slug,
      name: "render-upload-slides",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: "render-upload-slides",
        slug,
        input_schema: {
          type: "object",
          required: ["markdown", "filename"],
          properties: {
            markdown: { type: "string" },
            filename: { type: "string" },
            theme: { type: "string" },
          },
        },
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression:
              "return { filename: input.input.filename, theme: input.input.theme, markdown: input.input.markdown, confirmed: input.input.confirmed ?? null };",
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("workflow version insert failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(eq(workflows.id, workflow.id));
  return { workflow_id: workflow.id, slug };
}

describe("auto-persist on confirmation — save_connector_draft", () => {
  test("ask_user_confirm with run_workflow commit_intent executes with preserved input", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow();
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Run render-upload-slides?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: {
              markdown: "# Slides\n\nBody",
              filename: "slides-grundlagen-neutral.html",
              theme: "light",
            },
          },
          description: "Run render-upload-slides.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: "user-test",
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("run_workflow");
    const data = dispatch.synthetic_result?.data as {
      workflow_id: string;
      workflow_slug: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.workflow_id).toBe(workflow.workflow_id);
    expect(data.workflow_slug).toBe(workflow.slug);
    expect(data.input).toEqual({
      markdown: "# Slides\n\nBody",
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
    });
    expect(data.input).not.toHaveProperty("confirmed");
    expect(data.output).toMatchObject({
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
      markdown: "# Slides\n\nBody",
      confirmed: null,
    });
  });

  test("ask_user_confirm with run_workflow commit_intent parses JSON-string input", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-json-input");
    const input = {
      markdown: "# Slides\n\nBody",
      filename: "slides-grundlagen-neutral.html",
      theme: "light",
    };
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_confirm",
      input: {
        question: "Run render-upload-slides?",
        kind: "external_write",
        commit_intent: {
          kind: "run_workflow",
          payload: {
            workflow: workflow.slug,
            environment: "dev",
            input_partial: JSON.stringify(input),
          },
          description: "Run render-upload-slides.",
        },
      },
      output: { confirmed: true },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: "user-test",
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { confirmed: true },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    const data = dispatch.synthetic_result?.data as {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.input).toEqual(input);
    expect(data.output).toMatchObject({ ...input, confirmed: null });
  });

  test("run_workflow auto-dispatch with a REQUIRED field missing returns a directive error (not input_schema_violation)", async () => {
    // The form collected only `filename`; the workflow requires
    // {markdown, filename}. Pre-fix the merged input reached the driver
    // and threw the opaque `input_schema_violation` ("required field
    // 'markdown' is missing") from inside runExecution — surfaced to the
    // LLM as a generic dispatch.threw. Now the guard fails BEFORE
    // dispatch with a directive error naming the missing field(s) + how
    // to supply them.
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-missing-field");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide the inputs to run render-upload-slides",
        fields: [
          { name: "markdown", label: "markdown", type: "text", required: true },
          { name: "filename", label: "filename", type: "text", required: true },
        ],
        commit_intent: {
          kind: "run_workflow",
          payload: { workflow: workflow.slug, environment: "dev", input_partial: {} },
          description: "Run render-upload-slides.",
        },
      },
      // Operator submitted only `filename` — `markdown` left blank.
      output: { values: { filename: "slides.html" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: "user-test",
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { values: { filename: "slides.html" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(false);
    expect(dispatch.synthetic_result?.error_code).toBe("missing_workflow_input");
    // The directive message must name the missing field and steer the
    // model back to a full ask_user_form (never a free-text ask).
    expect(dispatch.synthetic_result?.message).toContain("markdown");
    expect(dispatch.synthetic_result?.message).toContain("ask_user_form");
    expect(dispatch.synthetic_result?.message).not.toContain("input_schema_violation");
    const data = dispatch.synthetic_result?.data as {
      missing_fields: string[];
      required_fields: string[];
    };
    expect(data.missing_fields).toEqual(["markdown"]);
    expect(data.required_fields.sort()).toEqual(["filename", "markdown"]);
  });

  test("run_workflow auto-dispatch with ALL required fields present dispatches the run", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const workflow = await seedRenderWorkflow("render-upload-slides-all-fields");
    const elicitation = await createCarrierElicitation({
      conversation_id,
      tool_name: "ask_user_form",
      input: {
        question: "Provide the inputs to run render-upload-slides",
        fields: [
          { name: "markdown", label: "markdown", type: "text", required: true },
          { name: "filename", label: "filename", type: "text", required: true },
        ],
        commit_intent: {
          kind: "run_workflow",
          payload: { workflow: workflow.slug, environment: "dev", input_partial: {} },
          description: "Run render-upload-slides.",
        },
      },
      output: { values: { markdown: "# Slides", filename: "slides.html" } },
    });

    const dispatch = await maybeAutoPersistFromElicitation({
      tenant_id,
      conversation_id,
      actor_id: null,
      principal: {
        provider: "test",
        kind: "user",
        id: "user-test",
        tenant_id,
        roles: ["admin"],
      },
      elicitation_output: { values: { markdown: "# Slides", filename: "slides.html" } },
      elicitation,
      db: ctx.db,
    });

    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.synthetic_result?.ok).toBe(true);
    expect(dispatch.synthetic_result?.tool).toBe("run_workflow");
    const data = dispatch.synthetic_result?.data as {
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(data.input).toMatchObject({ markdown: "# Slides", filename: "slides.html" });
    expect(data.output).toMatchObject({ markdown: "# Slides", filename: "slides.html" });
  });

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

    // Connector row exists.
    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, "ap-bearer")));
    expect(conn).toHaveLength(1);

    // Credential row exists.
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("bearer");

    // Audit row tagged with reason=auto_persist_on_confirmation.
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

    // Synthetic tool-call row injected with source=harness_auto_persist.
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);

    // Synthetic tool message in the timeline.
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
    // Reproduces the gmail/google-* BYO authorization_code flow that
    // pre-fix returned `credential_required` for every retry (session
    // 48eb113f-fe3b-48b6-a640-68836ec1e05e). The fix wires the
    // extractor + cache so a single form submit lands the connector
    // with client_id/client_secret in config.oauth and no
    // credential row — ready for authenticate_oauth.
    _resetDraftCredentialCacheForTests();

    // Build a gmail-shape draft. Note: probe checkpoint is intentionally
    // green (latest_probe.ok=true) because gmail's template has
    // probe_endpoint=null in production; the auto-persist path would
    // otherwise hit the probe gate. The integration test focuses on the
    // credential-extraction → persistCredential contract.
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
              // LLM-authored mustache placeholders — the form output
              // must win. SECRET_SEED_FIELDS strips client_secret, and
              // seedString rejects the mustache pattern for client_id.
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

    // Connector row exists exactly once.
    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
    expect(conn).toHaveLength(1);

    // config.oauth populated with the operator-typed values.
    const savedConfig = (conn[0]!.config ?? {}) as {
      oauth?: { client_id?: string; client_secret?: string };
    };
    expect(savedConfig.oauth?.client_id).toBe("my-google-client");
    expect(savedConfig.oauth?.client_secret).toBe("GOCSPX-real");

    // ZERO credential rows — the credential lands later via OAuth callback.
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(0);

    // Audit row exists with `result: "success"` and metadata source
    // tagged. The metadata MUST NOT carry the literal client_secret —
    // scrubSecrets in audit.ts strips it; this assertion locks that
    // contract in.
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
    // Secret redaction safety net — neither the audit row itself nor
    // any other audit row for this tenant should carry the literal
    // client_secret string. Pre-PR the LLM-authored commit_intent
    // (with `{{client_secret}}` placeholder) would have been the
    // closest leak risk; this guard locks the contract in.
    const auditAsJson = JSON.stringify(audit);
    expect(auditAsJson).not.toContain("GOCSPX-real");

    // Synthetic tool-call row.
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);

    // Draft cache cleared by saveConnectorAtomic on success.
    expect(getDraftCredential(conversation_id)).toBeNull();

    // connector_authenticated checkpoint MUST stay open until
    // authenticate_oauth — saving the seed does not bind a credential.
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
    // Regression for session 97679846 (Jira Cloud GraphQL): the LLM
    // authored a form with a single field named `basic_auth` for a
    // basic-auth draft. That field matched no extractor alias → the
    // submit-time extraction returned null → auto-persist failed with
    // `credential_required` AFTER the operator had already typed the
    // secret. The form-creation gate (credential-form-contract.ts)
    // now blocks mis-named fields at creation time. This test exercises
    // the full resume path: canonical `username` + `password` form
    // fields → elicitation resolved → credential cached with
    // mode "basic" → saveConnectorAtomic persists connector row +
    // credential row in the basic shape.
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

    // Connector row exists.
    const conn = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.slug, slug)));
    expect(conn).toHaveLength(1);

    // Credential row exists with mode "basic".
    const cred = await ctx.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.tenant_id, tenant_id), eq(credentials.connector_id, conn[0]!.id)));
    expect(cred).toHaveLength(1);
    expect(cred[0]!.mode).toBe("basic");

    // Audit row tagged reason=auto_persist_on_confirmation with
    // commit_intent_kind=save_connector_draft.
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

    // Synthetic tool-call row with source=harness_auto_persist.
    const calls = await ctx.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("save_connector_draft");
    const callOutput = calls[0]!.output as Record<string, unknown>;
    expect(callOutput.source).toBe("harness_auto_persist");
    expect(callOutput.ok).toBe(true);
    // credential_persisted flag lives inside data (from buildPersistencePayload).
    const callData = callOutput.data as Record<string, unknown> | undefined;
    expect(callData?.credential_persisted).toBe(true);

    // Draft credential cache cleared after save.
    expect(getDraftCredential(conversation_id)).toBeNull();

    // connector_persisted checkpoint must be fresh after the save.
    const liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
    const checkpoints = liveDraft.summary?.checkpoints ?? [];
    const persistedCheckpoint = checkpoints.find((cp) => cp.key === "connector_persisted");
    expect(persistedCheckpoint?.status).toBe("fresh");
  });
});

describe("auto-persist on confirmation — oauth_completed credential gate", () => {
  test("confirming the OAuth prompt with NO minted credential returns authenticated:false (not a false success)", async () => {
    // Regression for the LinkedIn session (connector d462743a): the
    // operator confirmed "Have you completed the authorization?" but the
    // provider never called back (zero oauth.callback hits / zero
    // credential.created). Pre-fix the oauth_completed dispatcher reported
    // authenticated:true unconditionally, so the LLM retried the connector
    // and hit an auth failure while the operator was told it was active.
    // Now it verifies a credential actually exists first.
    const { conversation_id } = await seedConversationWithDraft("ap-oauth-nocred");
    // A connector id with no credential row — the pre-token state.
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
});
