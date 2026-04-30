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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { conversations as conversationsTable, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";

const uuid = createDeterministicUuidFactory(0xd4af7_c4ed);

import { EngineClient } from "../../engine-client/index.ts";
import { startLocalTargetServer } from "../../tunnels/tests/setup.ts";
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
});

describe("probe_connector_draft + draft credential", () => {
  test("sends Authorization: Bearer <token> when cache populated", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = startLocalTargetServer((req) => {
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
    const server = startLocalTargetServer(() => {
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

  test("auth_type=none drafts probe without a credential", async () => {
    const captured: { auth: string | null } = { auth: null };
    const server = startLocalTargetServer((req) => {
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
});
