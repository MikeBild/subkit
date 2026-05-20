// Integration coverage for the draft-time credential injection path.
//
// Pre-fix symptom: `probe_connector_draft` issues an HTTP request via
// `executeConnectorHttpRequest` against a synthetic `draft-<id>`
// connector. `getCredentialForConnector` short-circuits non-UUID ids
// to null, so no Authorization header is stamped — the upstream sees
// an unauthenticated probe and returns 401 / "Last used: Never".
//
// Post-fix: an `ask_user_form` submission populates the in-memory
// draft credential cache via `maybeCacheDraftCredentialFromElicitation`.
// `probe_connector_draft` reads from the cache and threads the
// credential through `executeConnectorHttpRequest` as a
// `credential_override`. The HTTP driver applies it the same way it
// would a stored credential.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { conversations as conversationsTable, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

const uuid = createDeterministicUuidFactory(0xd4af7_c4ed);

import * as discoveryService from "../../connectors/discovery/service.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { startLocalTargetServer } from "../../test-helpers/local-http.ts";
import {
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import {
  extractCredentialFromFormOutput,
  maybeCacheDraftCredentialFromElicitation,
} from "../persistence/auto-persist.ts";
import {
  _resetDraftCredentialCacheForTests,
  clearDraftCredential,
  getDraftCredential,
  setDraftCredential,
  toDecryptedCredential,
} from "../persistence/draft-credential-cache.ts";
import type { ToolContext } from "../tools/index.ts";
import { probeConnectorDraftTool } from "../tools/probe-connector-draft.ts";
import type { DraftDocument } from "../types.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("draft_probe_credential");
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
      validation: validateConnectorDraft(baseDraft.connector ?? null),
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

async function buildToolCtx(conversation_id: string, draft: DraftDocument): Promise<ToolContext> {
  await appendSnapshot(tenant_id, conversation_id, draft, ctx.db);
  let liveDraft = await loadDraft(tenant_id, conversation_id, ctx.db);
  return {
    db: ctx.db,
    tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.db,
    }),
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      liveDraft = next;
      await appendSnapshot(tenant_id, conversation_id, next, ctx.db);
    },
  };
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

  // Regression: conversation 730c568a. The LLM's commit_intent carried
  // `payload.credential.token = "{{token}}"` (a Mustache placeholder
  // for the form value). Pre-fix the extractor saw a non-empty string
  // in the seed and used it verbatim, persisting `Bearer {{token}}`
  // and 401-ing every subsequent execution.
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

  // Audit gap: cognito_user_password and aws_sigv4 modes were not
  // covered by the earlier placeholder regression. Same risk class —
  // an LLM commit_intent like `{aws_region: "{{aws_region}}", …}`
  // would leak the literal placeholder into the persisted credential.
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
    // Reproduces the bug from session f244b896. Draft is the
    // appsync-cognito template shape: oauth2 + cognito_user_password.
    // Form delivers username + password. Pre-fix the gate only let
    // bearer/basic/header/query through; this asserts the new
    // translation that maps oauth2 → cognito_user_password seed when
    // the connector config carries `oauth.grant_type` accordingly.
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
      // Connector config seeds these so the bootstrap mint has them.
      aws_region: "eu-central-1",
      client_id: "client-abc",
    });
  });

  test("falls back to template snapshot when draft.config.oauth is empty (real AppSync flow)", async () => {
    // Reproduces the actual session a2292e7a bug: the draft is bound
    // to the appsync-cognito builtin template but config.oauth is null
    // because template-enrichment only runs at save time. Pre-fix the
    // extractor read draft.config.oauth.grant_type → null → seedMode
    // null → cache_skipped → probe ran unauthenticated → connector
    // never persisted. The fallback now consults the template's
    // oauth.grant_type.
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
        // config.oauth deliberately absent — template-enrichment runs
        // only at saveConnectorAtomic time.
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
    // Reproduces the gmail/google-*/msgraph BYO flow that pre-fix hit
    // `cache_skipped` for every form submission. The operator supplies
    // client_id + client_secret via ask_user_form; the seed lands in
    // the cache so a credential-less re-save reads it back.
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
    // First-save case: the draft is bound to the google-gmail template
    // but config.oauth.grant_type isn't enriched yet (that runs at
    // saveConnectorAtomic time). The cache function must look up
    // grant_type from the resolved template metadata.
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

    // The cache stays empty; the engine log line `cache_skipped` is the
    // forensic signal for the next person adding a grant type.
    expect(getDraftCredential(conversation_id)).toBeNull();
  });
});

describe("probe_connector_draft + draft credential", () => {
  // Stub post-save auto-discovery so graphql connector saves in this
  // describe block never launch a real browser (playwright-crawl) or make
  // live network calls. The fire-and-forget `void runDiscoveryCached(...)`
  // inside saveConnectorAtomic would otherwise become an unhandled rejection
  // attributed to whichever test is in-flight when the browser spawn fails.
  // The spy returns a minimal valid DiscoveryServiceResult that the
  // `.then()` handler inside save-connector.ts consumes without throwing.
  let discoverySpy: ReturnType<typeof spyOn<typeof discoveryService, "runDiscoveryCached">>;
  beforeAll(() => {
    discoverySpy = spyOn(discoveryService, "runDiscoveryCached").mockResolvedValue({
      source: "fresh",
      cache_key: "url:stub",
      result: {
        source_url: "",
        // Fixed timestamp — value is never asserted; a literal keeps the
        // determinism lint happy (no `new Date()` in *.test.ts).
        fetched_at: "2023-11-14T22:13:20.000Z",
        strategy: "graphql-introspect",
        spec_version: null,
        title: null,
        servers: [],
        auth_schemes: [],
        endpoints: [],
        warnings: [],
      },
    });
  });
  afterAll(() => {
    discoverySpy.mockRestore();
  });

  test("sends Authorization: Bearer <token> when cache populated", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);

      setDraftCredential(conversation_id, { mode: "bearer", token: "DO-TEST-TOKEN" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBe("Bearer DO-TEST-TOKEN");
    } finally {
      await server.stop();
    }
  });

  test("returns credential_required when cache is empty for auth-required draft", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft = buildBearerDraft(server.url);
      const toolCtx = await buildToolCtx(conversation_id, draft);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/v2/projects",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_required");
      expect(data.recommended_next).toContain("ask_user_form");
    } finally {
      await server.stop();
    }
  });

  test("returns authenticate_oauth_required envelope for an oauth2 BYO cache hit (no HTTP request)", async () => {
    // After the gmail/google-* BYO fix the draft credential cache can
    // legitimately hold an `{mode:"oauth2"}` seed. Probing that draft
    // BEFORE authenticate_oauth completes the browser exchange can't
    // succeed — the access token doesn't exist yet. The probe MUST
    // surface a typed `authenticate_oauth_required` envelope rather
    // than letting `toDecryptedCredential` throw the cryptic
    // "oauth2 seed updates config.oauth only" Error string into
    // turn-context. Also verifies no HTTP request reaches the
    // upstream — the gate fires server-side before the connector
    // call.
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach upstream", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gmailDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "Gmail API",
          slug: "gmail-api",
          driver: "http",
          environment: "dev",
          auth_type: "oauth2",
          base_url: server.url,
          config: { oauth: { grant_type: "authorization_code" } },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gmailDraft),
        {
          ...gmailDraft.connector,
          validation: validateConnectorDraft(gmailDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      setDraftCredential(conversation_id, {
        mode: "oauth2",
        client_id: "client-abc",
        client_secret: "secret-xyz",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/users/me/profile",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("authenticate_oauth_required");
      expect(data.recommended_next).toContain("authenticate_oauth");
    } finally {
      await server.stop();
    }
  });

  test("auth_type=none drafts probe without a credential", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = await startLocalTargetServer((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response("ok", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const draft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "open",
          slug: "open",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(draft),
        {
          ...draft.connector,
          validation: validateConnectorDraft(draft.connector ?? null),
        },
        true,
        "ok",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(captured.auth).toBeNull();
    } finally {
      await server.stop();
    }
  });

  // RC-1: graphql-driver connector with a bearer draft credential in the
  // cache. The tool must run the introspection probe (POSTs `{__typename}`)
  // and reach the endpoint, NOT the raw-HTTP path which sends an empty body.
  test("graphql driver with bearer cache hit — introspection reaches the endpoint", async () => {
    const captured: { body: string | null; auth: string | null } = { body: null, auth: null };
    const server = await startLocalTargetServer(async (req) => {
      // Only capture the first POST — fire-and-forget discovery sends GETs
      // after the probe completes and would overwrite captured.body with "".
      if (req.method === "POST" && captured.body === null) {
        captured.auth = req.headers.get("authorization");
        const text = await req.text();
        captured.body = text;
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-bearer",
          slug: "gql-bearer",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, { mode: "bearer", token: "gql-test-token" });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      // The server received a GraphQL body (introspection), not an empty POST.
      expect(captured.body).toContain("__typename");
      expect(captured.auth).toBe("Bearer gql-test-token");
    } finally {
      await server.stop();
    }
  });

  // RC-1: graphql-driver connector with NO cached credential and auth required.
  // The gate must return credential_required before the server is hit.
  test("graphql driver without cached credential — credential_required, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-no-cred",
          slug: "gql-no-cred",
          driver: "graphql",
          environment: "dev",
          auth_type: "bearer",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      // Cache is empty (afterEach resets it).

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("credential_required");
      expect(data.recommended_next).toContain("ask_user_form");
    } finally {
      await server.stop();
    }
  });

  // RC-1: cognito_user_password cache hit — probe mints an IdToken via
  // Cognito and forwards it as a raw JWT (no "Bearer" prefix) to the graphql
  // endpoint. runCognitoUserPasswordGrant is stubbed via globalThis.fetch spy.
  test("graphql driver with cognito_user_password cache hit — minted JWT reaches endpoint as raw token", async () => {
    const capturedAuth: { value: string | null } = { value: null };

    // Stand up a mock GraphQL server that records the auth header.
    // Only capture from the first POST — discovery fire-and-forget sends GETs
    // that would overwrite capturedAuth with null.
    const gqlServer = await startLocalTargetServer(async (req) => {
      if (req.method === "POST" && capturedAuth.value === null) {
        capturedAuth.value = req.headers.get("authorization");
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Stub `runCognitoUserPasswordGrant` by intercepting globalThis.fetch.
    // The Cognito endpoint is cognito-idp.<region>.amazonaws.com so any
    // fetch to that host returns our fake AuthenticationResult.
    // Save a reference to the original fetch BEFORE installing the spy
    // so the pass-through branch can call it without recursing into the spy.
    const originalFetch = globalThis.fetch;
    // Cast to `typeof fetch` via `unknown` — the mock signature covers only the
    // relevant subset (url + init) that Cognito + the graphql driver use.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("cognito-idp")) {
        return new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: "minted-id-token-jwt",
              ExpiresIn: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } },
        );
      }
      // Real fetch for the graphql mock server.
      return originalFetch(url, init);
    }) as typeof fetch);

    try {
      const conversation_id = await seedConversation();
      const cognitoDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "appsync-cognito",
          slug: "appsync-cognito",
          driver: "graphql",
          environment: "dev",
          auth_type: "oauth2",
          base_url: gqlServer.url,
          config: {
            aws_region: "eu-central-1",
            oauth: { client_id: "client-abc", grant_type: "cognito_user_password" },
          },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(cognitoDraft),
        {
          ...cognitoDraft.connector,
          validation: validateConnectorDraft(cognitoDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, {
        mode: "cognito_user_password",
        username: "user@example.com",
        password: "hunter2",
        aws_region: "eu-central-1",
        client_id: "client-abc",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "POST",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      // token_type is "none" for Cognito — the JWT is sent without a "Bearer" prefix.
      expect(capturedAuth.value).toBe("minted-id-token-jwt");
    } finally {
      fetchSpy.mockRestore();
      await gqlServer.stop();
    }
  });

  // RC-1: graphql probe with an explicit path arg (e.g. path:"/graphql") still
  // runs the {__typename} introspection — NOT an empty POST or a path-based HTTP
  // request. The fix removed the `&& args.path === "/"` guard so any path arg
  // causes the graphql probe branch to fire.
  test("graphql probe with explicit path arg still runs introspection (body contains __typename)", async () => {
    const captured: { body: string | null } = { body: null };
    const server = await startLocalTargetServer(async (req) => {
      // Only record the first POST body — discovery fire-and-forget sends
      // subsequent GETs that would overwrite captured.body with "".
      if (req.method === "POST" && captured.body === null) {
        const text = await req.text();
        captured.body = text;
      }
      return new Response(JSON.stringify({ data: { __typename: "Query" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const conversation_id = await seedConversation();
      const gqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-explicit-path",
          slug: "gql-explicit-path",
          driver: "graphql",
          environment: "dev",
          auth_type: "none",
          base_url: server.url,
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gqlDraft),
        {
          ...gqlDraft.connector,
          validation: validateConnectorDraft(gqlDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(true);
      // The request body must be a GraphQL query (introspection), never empty.
      expect(captured.body).not.toBe("");
      expect(captured.body).not.toBeNull();
      const parsed = JSON.parse(captured.body!) as { query?: string };
      expect(parsed.query).toContain("__typename");
    } finally {
      await server.stop();
    }
  });

  // RC-1: BYO oauth2 seed cached (mode "oauth2") on a graphql connector returns
  // authenticate_oauth_required — same gate as the HTTP path.
  test("graphql driver with oauth2 seed cached returns authenticate_oauth_required, server never hit", async () => {
    let serverHit = false;
    const server = await startLocalTargetServer(() => {
      serverHit = true;
      return new Response("should not reach", { status: 200 });
    });
    try {
      const conversation_id = await seedConversation();
      const gmailGraphqlDraft: DraftDocument = {
        mode: "connector_authoring",
        connector: {
          name: "gql-oauth2-byo",
          slug: "gql-oauth2-byo",
          driver: "graphql",
          environment: "dev",
          auth_type: "oauth2",
          base_url: server.url,
          config: { oauth: { grant_type: "authorization_code" } },
        },
        workflow: { name: "", steps: [] },
      };
      const validated = withConnectorValidation(
        withConnectorInspection(gmailGraphqlDraft),
        {
          ...gmailGraphqlDraft.connector,
          validation: validateConnectorDraft(gmailGraphqlDraft.connector ?? null),
        },
        true,
        "validated",
      );
      const toolCtx = await buildToolCtx(conversation_id, validated);
      setDraftCredential(conversation_id, {
        mode: "oauth2",
        client_id: "client-abc",
        client_secret: "secret-xyz",
      });

      const result = await probeConnectorDraftTool.execute(toolCtx, {
        method: "GET",
        path: "/graphql",
        timeout_ms: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(serverHit).toBe(false);
      const data = result.data as { error_code?: string; recommended_next?: string[] };
      expect(data.error_code).toBe("authenticate_oauth_required");
      expect(data.recommended_next).toContain("authenticate_oauth");
    } finally {
      await server.stop();
    }
  });
});
