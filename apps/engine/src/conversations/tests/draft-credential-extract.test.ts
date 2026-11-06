import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { conversations as conversationsTable, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

const uuid = createDeterministicUuidFactory(0xd4af7_c4ed);

import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot } from "../draft.ts";
import {
  extractCredentialFromFormOutput,
  maybeCacheDraftCredentialFromElicitation,
} from "../persistence/auto-persist/index.ts";
import {
  _resetDraftCredentialCacheForTests,
  clearDraftCredential,
  getDraftCredential,
  setDraftCredential,
  toDecryptedCredential,
} from "../persistence/draft-credential-cache.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("draft_credential_extract");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-dpc", display_name: "T-DPC" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  _resetDraftCredentialCacheForTests();
});

function buildBearerDraft(baseUrl: string): DraftDocument {
  const baseDraft: DraftDocument = {
    mode: "connector_authoring",
    connector: {
      name: "do-test",
      slug: "do-test",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: baseUrl,
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
  return withConnectorProbe(validated, { ...validated.connector }, true, "ready to probe");
}

async function seedConversation(): Promise<string> {
  const [row] = await ctx.db
    .insert(conversationsTable)
    .values({ tenant_id, status: "awaiting_input" })
    .returning();
  return row!.id;
}

describe("draft credential cache", () => {
  test("set/get/clear round-trip", () => {
    const id = uuid();
    expect(getDraftCredential(id)).toBeNull();
    setDraftCredential(id, { mode: "bearer", token: "abc" });
    expect(getDraftCredential(id)).toEqual({ mode: "bearer", token: "abc" });
    clearDraftCredential(id);
    expect(getDraftCredential(id)).toBeNull();
  });

  test("toDecryptedCredential maps shapes correctly", () => {
    expect(toDecryptedCredential({ mode: "bearer", token: "t" })).toEqual({
      mode: "bearer",
      token: "t",
    });
    expect(toDecryptedCredential({ mode: "basic", username: "u", password: "p" })).toEqual({
      mode: "basic",
      username: "u",
      password: "p",
    });
    expect(
      toDecryptedCredential({ mode: "header", header_name: "X-Api", header_value: "k" }),
    ).toEqual({ mode: "header", headers: { "X-Api": "k" } });
    expect(toDecryptedCredential({ mode: "query", param: "key", value: "v" })).toEqual({
      mode: "query",
      query: { key: "v" },
    });
  });
});

describe("extractCredentialFromFormOutput", () => {
  test("bearer picks `token` from a flat output", () => {
    expect(extractCredentialFromFormOutput("bearer", {}, { token: "t-123" })).toEqual({
      mode: "bearer",
      token: "t-123",
    });
  });

  test("bearer falls back to api_key / secret / case-insensitive variants", () => {
    expect(extractCredentialFromFormOutput("bearer", {}, { API_KEY: "k-1" })).toEqual({
      mode: "bearer",
      token: "k-1",
    });
    expect(extractCredentialFromFormOutput("bearer", {}, { Secret: "s" })).toEqual({
      mode: "bearer",
      token: "s",
    });
  });

  test("basic requires both username and password", () => {
    expect(extractCredentialFromFormOutput("basic", {}, { username: "u" })).toBeNull();
    expect(extractCredentialFromFormOutput("basic", {}, { username: "u", password: "p" })).toEqual({
      mode: "basic",
      username: "u",
      password: "p",
    });
  });

  test("returns null for missing fields", () => {
    expect(extractCredentialFromFormOutput("bearer", {}, {})).toBeNull();
    expect(extractCredentialFromFormOutput("bearer", {}, { token: "" })).toBeNull();
  });

  test("rejects mustache placeholders in seed overrides so the form value wins", () => {
    expect(
      extractCredentialFromFormOutput("bearer", { token: "{{token}}" }, { token: "real-pat-123" }),
    ).toEqual({ mode: "bearer", token: "real-pat-123" });
    expect(
      extractCredentialFromFormOutput(
        "basic",
        { username: "{{username}}", password: "{{password}}" },
        { username: "alice", password: "p4ss" },
      ),
    ).toEqual({ mode: "basic", username: "alice", password: "p4ss" });
    expect(
      extractCredentialFromFormOutput(
        "header",
        { header_name: "X-API-Key", header_value: "{{header_value}}" },
        { header_value: "real-key" },
      ),
    ).toEqual({ mode: "header", header_name: "X-API-Key", header_value: "real-key" });
    expect(
      extractCredentialFromFormOutput(
        "query",
        { param: "api_key", value: "{{value}}" },
        { value: "real-q" },
      ),
    ).toEqual({ mode: "query", param: "api_key", value: "real-q" });
  });

  test("cognito_user_password rejects mustache placeholders in optional metadata", () => {
    const result = extractCredentialFromFormOutput(
      "cognito_user_password",
      {
        username: "{{username}}",
        password: "{{password}}",
        aws_region: "{{aws_region}}",
        client_id: "{{client_id}}",
      },
      {
        username: "alice@example.com",
        password: "p4ss",
        aws_region: "us-east-1",
        client_id: "client-xyz",
      },
    );
    expect(result).toEqual({
      mode: "cognito_user_password",
      username: "alice@example.com",
      password: "p4ss",
      aws_region: "us-east-1",
      client_id: "client-xyz",
    });
  });

  test("aws_sigv4 rejects mustache placeholders on access_key_id and secret_access_key", () => {
    const result = extractCredentialFromFormOutput(
      "aws_sigv4",
      {
        access_key_id: "{{access_key_id}}",
        secret_access_key: "{{secret_access_key}}",
        session_token: "{{session_token}}",
      },
      {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        session_token: "FQoG...",
      },
    );
    expect(result).toEqual({
      mode: "aws_sigv4",
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      session_token: "FQoG...",
    });
  });
});

describe("maybeCacheDraftCredentialFromElicitation", () => {
  test("populates cache for ask_user_form on bearer-auth draft", async () => {
    const conversation_id = await seedConversation();
    const draft = buildBearerDraft("https://api.example.test");
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);

    expect(getDraftCredential(conversation_id)).toBeNull();
    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { token: "t-cached" },
      db: ctx.db,
    });

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "bearer",
      token: "t-cached",
    });
  });

  test("no-ops for non-form elicitations", async () => {
    const conversation_id = await seedConversation();
    const draft = buildBearerDraft("https://api.example.test");
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_confirm" },
      elicitation_output: { confirmed: true },
      db: ctx.db,
    });
    expect(getDraftCredential(conversation_id)).toBeNull();
  });

  test("no-ops for drafts without auth-required connectors", async () => {
    const conversation_id = await seedConversation();
    const draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "open",
        slug: "open",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://open.example.test",
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { token: "ignored" },
      db: ctx.db,
    });
    expect(getDraftCredential(conversation_id)).toBeNull();
  });

  test("populates cache from oauth2 + cognito_user_password draft (AppSync flow)", async () => {
    const conversation_id = await seedConversation();
    const cognitoDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "AppSync",
        slug: "appsync",
        driver: "graphql",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
        config: {
          aws_region: "eu-central-1",
          oauth: { client_id: "client-abc", grant_type: "cognito_user_password" },
        },
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, cognitoDraft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { username: "user@example.com", password: "hunter2" },
      db: ctx.db,
    });

    const cached = getDraftCredential(conversation_id);
    expect(cached).toEqual({
      mode: "cognito_user_password",
      username: "user@example.com",
      password: "hunter2",
      aws_region: "eu-central-1",
      client_id: "client-abc",
    });
  });

  test("falls back to template snapshot when draft.config.oauth is empty (real AppSync flow)", async () => {
    const conversation_id = await seedConversation();
    const draftBeforeEnrichment: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "AppSync Chargers API",
        slug: "appsync-chargers",
        driver: "graphql",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
        template_slug: "appsync-cognito",
        config: {},
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, draftBeforeEnrichment, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { username: "ops@example.com", password: "pw-123" },
      db: ctx.db,
    });

    const cached = getDraftCredential(conversation_id);
    expect(cached).not.toBeNull();
    expect(cached?.mode).toBe("cognito_user_password");
    if (cached?.mode === "cognito_user_password") {
      expect(cached.username).toBe("ops@example.com");
      expect(cached.password).toBe("pw-123");
    }
  });

  test("populates cache from aws_sigv4 draft (AppSync IAM flow)", async () => {
    const conversation_id = await seedConversation();
    const sigv4Draft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "AppSync IAM",
        slug: "appsync-iam",
        driver: "graphql",
        environment: "dev",
        auth_type: "aws_sigv4",
        base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
        config: { aws_region: "eu-central-1", aws_service: "appsync" },
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, sigv4Draft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: {
        access_key_id: "AKIATEST",
        secret_access_key: "shh",
        session_token: "FwoGZXIvYXdz...",
      },
      db: ctx.db,
    });

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "aws_sigv4",
      access_key_id: "AKIATEST",
      secret_access_key: "shh",
      session_token: "FwoGZXIvYXdz...",
    });
  });

  test("populates cache from oauth2 + authorization_code draft (gmail BYO flow)", async () => {
    const conversation_id = await seedConversation();
    const gmailDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "Gmail API",
        slug: "gmail-api",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://gmail.googleapis.com/gmail/v1",
        config: { oauth: { grant_type: "authorization_code" } },
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, gmailDraft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: {
        values: { client_id: "my-google-client", client_secret: "GOCSPX-real" },
      },
      db: ctx.db,
    });

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "oauth2",
      client_id: "my-google-client",
      client_secret: "GOCSPX-real",
    });
  });

  test("falls back to template snapshot for oauth2 + authorization_code when draft.config.oauth absent", async () => {
    const conversation_id = await seedConversation();
    const draftBeforeEnrichment: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "Gmail API",
        slug: "gmail-api",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://gmail.googleapis.com/gmail/v1",
        template_slug: "google-gmail",
        config: {},
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, draftBeforeEnrichment, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { values: { client_id: "abc", client_secret: "xyz" } },
      db: ctx.db,
    });

    const cached = getDraftCredential(conversation_id);
    expect(cached?.mode).toBe("oauth2");
    if (cached?.mode === "oauth2") {
      expect(cached.client_id).toBe("abc");
      expect(cached.client_secret).toBe("xyz");
    }
  });

  test("populates cache from oauth2 + client_credentials draft (machine-to-machine)", async () => {
    const conversation_id = await seedConversation();
    const ccDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "service-account",
        slug: "service-account",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://api.example.test",
        config: { oauth: { grant_type: "client_credentials" } },
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, ccDraft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { values: { client_id: "svc-id", client_secret: "svc-secret" } },
      db: ctx.db,
    });

    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "oauth2",
      client_id: "svc-id",
      client_secret: "svc-secret",
    });
  });

  test("skips cache for unrecognised grant_type (e.g. jwt-bearer) — forensic log path stays exercised", async () => {
    const conversation_id = await seedConversation();
    const jwtBearerDraft: DraftDocument = {
      mode: "connector_authoring",
      connector: {
        name: "jwt-bearer",
        slug: "jwt-bearer",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://api.example.test",
        config: { oauth: { grant_type: "jwt-bearer" } },
      },
      workflow: { name: "", steps: [] },
    };
    await appendSnapshot(tenant_id, conversation_id, jwtBearerDraft, ctx.db);

    await maybeCacheDraftCredentialFromElicitation({
      tenant_id,
      conversation_id,
      elicitation: { tool_name: "ask_user_form" },
      elicitation_output: { values: { client_id: "abc" } },
      db: ctx.db,
    });

    expect(getDraftCredential(conversation_id)).toBeNull();
  });
});
