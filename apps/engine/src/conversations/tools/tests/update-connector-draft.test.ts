// Unit tests for update_connector_draft credential-shape rejection.
//
// Credential-shape detection fires BEFORE any DB or draft mutation, so
// rejection tests need only a minimal mock context. Clean-pass tests
// exercise the full tool including template resolution and require a
// live DB (createTestDb).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { findAuthParamConfigKey, updateConnectorDraftTool } from "../update-connector-draft.ts";

// ---------------------------------------------------------------------------
// Pure unit tests — credential-shape rejection (no DB required)
// ---------------------------------------------------------------------------

// A minimal stub: only the fields the rejection path touches.
const stubCtx = {
  conversation_id: "test-conv",
  tenant_id: "test-tenant",
  actor_id: null,
  connector_id: null,
  workflow_id: null,
  getDraft: () => createEmptyDraftDocument(),
  setDraft: async () => {},
} as unknown as ToolContext;

describe("findAuthParamConfigKey — auth-param-name key detection", () => {
  // Intended matches: a qualifier (auth_/query_ prefix OR a _name/_param/_key/
  // _arg suffix) must be present.
  const positives = [
    "query_param_name",
    "query_parameter_name",
    "query_param",
    "param_name",
    "query_key",
    "auth_param",
    "auth_query_param",
    "token_param",
    "query_arg_name",
    "key_name",
  ];
  // Bare generic tokens and ordinary HTTP-config keys must NOT match, or the
  // detector would mis-flag a real config key as the auth param name.
  const negatives = [
    "key",
    "token",
    "arg",
    "query",
    "param",
    "parameter",
    "timeout_ms",
    "static_headers",
    "static_query",
    "query_defaults",
    "query_timeout",
    "oauth",
  ];

  for (const k of positives) {
    it(`matches auth-param key "${k}"`, () => {
      expect(findAuthParamConfigKey({ [k]: "x" })).toBe(k);
    });
  }
  for (const k of negatives) {
    it(`does NOT match ordinary key "${k}"`, () => {
      expect(findAuthParamConfigKey({ [k]: "x" })).toBeNull();
    });
  }
});

describe("update_connector_draft — credential-shape rejection", () => {
  it("rejects a top-level credential key in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { credential: "some-value" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
      expect(result.message).toContain("ask_user_form");
      expect(result.next_best_actions).toEqual(
        expect.arrayContaining(["ask_user_form", "save_connector_draft"]),
      );
    }
  });

  it("rejects a nested token key under auth", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { auth: { token: "abc123" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a DigitalOcean PAT token-shape value at any key", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { whatever: "dop_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a GitHub PAT token-shape value", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { mykey: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a JWT-shaped value", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects an api_key field in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { api_key: "not-blank" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects a password field in config", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { password: "hunter2" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("rejects Authorization as a static_headers key (static_headers.Authorization matches key pattern)", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { static_headers: { Authorization: "static" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("credential_must_use_form");
    }
  });

  it("does not mutate the draft on rejection", async () => {
    const emptyDraft = createEmptyDraftDocument();
    let storedDraft = emptyDraft;
    const ctx: ToolContext = {
      ...stubCtx,
      getDraft: () => emptyDraft,
      setDraft: async (next: DraftDocument) => {
        storedDraft = next;
      },
    };
    await updateConnectorDraftTool.execute(ctx, {
      config: { token: "secret" },
    });
    // setDraft was NOT called — draft remains the original empty document.
    expect(storedDraft).toBe(emptyDraft);
  });

  it("surfaces the structured error envelope shape", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { secret: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // error_code is machine-readable, message is human-readable.
      expect(typeof result.error_code).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(Array.isArray(result.next_best_actions)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests — query-auth param-name in config rejection (no DB)
// ---------------------------------------------------------------------------
//
// Reproduces production session aba4551f (the Browserless connector): the
// model invented `config.query_param_name`, the `.strict()`
// HttpConnectorConfig rejected it at save with the opaque "invalid http
// connector config", and — given no actionable hint — the model re-added
// the key and looped for minutes. The guard fails fast here with a
// directed message so the model self-corrects in one turn.

describe("update_connector_draft — query-auth param-name in config rejection", () => {
  const KEYS = [
    "query_param_name",
    "query_parameter_name",
    "query_param",
    "param_name",
    "query_key",
    "auth_param",
    "auth_query_param",
    "token_param",
  ];

  for (const key of KEYS) {
    it(`rejects config.${key} with auth_param_name_in_config + actionable next steps`, async () => {
      const result = await updateConnectorDraftTool.execute(stubCtx, {
        config: { [key]: "token" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("auth_param_name_in_config");
        // Message redirects to the credential's `param` field, not config.
        expect(result.message).toContain("param");
        expect(result.message).toContain(key);
        expect(result.next_best_actions).toEqual(
          expect.arrayContaining(["ask_user_form", "save_connector_draft"]),
        );
      }
    });
  }

  it("is case-insensitive (config.Query_Param_Name)", async () => {
    const result = await updateConnectorDraftTool.execute(stubCtx, {
      config: { Query_Param_Name: "token" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("auth_param_name_in_config");
    }
  });

  it("does not mutate the draft on rejection", async () => {
    const emptyDraft = createEmptyDraftDocument();
    let storedDraft = emptyDraft;
    const ctx2: ToolContext = {
      ...stubCtx,
      getDraft: () => emptyDraft,
      setDraft: async (next: DraftDocument) => {
        storedDraft = next;
      },
    };
    await updateConnectorDraftTool.execute(ctx2, { config: { query_param_name: "token" } });
    expect(storedDraft).toBe(emptyDraft);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — clean updates require DB + template resolution
// ---------------------------------------------------------------------------

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("update_connector_draft");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function makeCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "update-connector-draft-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  const base: ToolContext = {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: created.conversation.id,
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as never,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
  };
  return { base, getDraft: () => draft };
}

describe("update_connector_draft — clean updates pass", () => {
  it("accepts a clean base_url update without config", async () => {
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      name: "My API",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "none",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a config with only non-sensitive keys", async () => {
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      config: { base_url: "https://api.example.com", timeout_ms: 5000, retries: 3 },
    });
    expect(result.ok).toBe(true);
  });

  it("mutates the draft on a clean update", async () => {
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Updated Name",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    expect(getDraft().connector?.name).toBe("Updated Name");
  });

  it("rejects auth_type downgrade to 'none' when a credential is cached", async () => {
    // Reproduces session bab50df1: the LLM, faced with a probe failure,
    // tried "switch auth_type back to none" as a workaround. With a
    // credential already in the draft cache that flips the connector
    // into a state where the next probe surfaces credential_required,
    // and the LLM oscillates. The downgrade must be refused so the
    // operator gets a clear next-best-action set.
    const { setDraftCredential, _resetDraftCredentialCacheForTests } = await import(
      "../../persistence/draft-credential-cache.ts"
    );
    _resetDraftCredentialCacheForTests();
    const { base } = await makeCtx();
    // Stage an oauth2 connector + cached credential.
    await updateConnectorDraftTool.execute(base, {
      name: "AppSync",
      driver: "graphql",
      environment: "dev",
      base_url: "https://abc.appsync-api.eu-central-1.amazonaws.com/graphql",
      auth_type: "oauth2",
    });
    setDraftCredential(base.conversation_id, {
      mode: "cognito_user_password",
      username: "u@example.com",
      password: "pw",
    });
    const result = await updateConnectorDraftTool.execute(base, { auth_type: "none" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("auth_type_downgrade_blocked");
      expect(result.next_best_actions).toEqual(
        expect.arrayContaining(["ask_user_form", "save_connector_draft"]),
      );
    }
    _resetDraftCredentialCacheForTests();
  });

  it("refuses an invalid auth edit whole: the draft and the entered key stay", async () => {
    const { setDraftCredential, getDraftCredential, _resetDraftCredentialCacheForTests } =
      await import("../../persistence/draft-credential-cache.ts");
    _resetDraftCredentialCacheForTests();
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Reporting MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://reporting.acme-analytics.io/api/mcp",
      auth_type: "bearer",
    });
    setDraftCredential(base.conversation_id, { mode: "bearer", token: "entered-by-operator" });
    const before = getDraft().connector;
    const result = await updateConnectorDraftTool.execute(base, {
      auth_type: "header",
      config: { mcp: { transport: "http", auth: { kind: "header", header_name: "X-API-KEY" } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("invalid_connector_draft_edit");
    expect(getDraft().connector).toEqual(before);
    expect(getDraftCredential(base.conversation_id)).toEqual({
      mode: "bearer",
      token: "entered-by-operator",
    });
    _resetDraftCredentialCacheForTests();
  });

  it("accepts a switch of an mcp draft to header auth and asks for the key again", async () => {
    const { setDraftCredential, getDraftCredential, _resetDraftCredentialCacheForTests } =
      await import("../../persistence/draft-credential-cache.ts");
    _resetDraftCredentialCacheForTests();
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Reporting MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://reporting.acme-analytics.io/api/mcp",
      auth_type: "bearer",
    });
    setDraftCredential(base.conversation_id, { mode: "bearer", token: "entered-by-operator" });
    const result = await updateConnectorDraftTool.execute(base, {
      auth_type: "header",
      config: { mcp: { transport: "http", auth: { kind: "header" } } },
    });
    expect(result.ok).toBe(true);
    expect(getDraft().connector?.validation?.errors ?? []).toEqual([]);
    expect(getDraftCredential(base.conversation_id)).toBeNull();
    _resetDraftCredentialCacheForTests();
  });

  it("lets auth_type alone switch an mcp draft: the sign-in kind follows it", async () => {
    const { setDraftCredential, getDraftCredential, _resetDraftCredentialCacheForTests } =
      await import("../../persistence/draft-credential-cache.ts");
    _resetDraftCredentialCacheForTests();
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Reporting MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://reporting.acme-analytics.io/api/mcp",
      auth_type: "bearer",
      config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
    });
    setDraftCredential(base.conversation_id, { mode: "bearer", token: "entered-by-operator" });
    const result = await updateConnectorDraftTool.execute(base, { auth_type: "header" });
    expect(result.ok).toBe(true);
    expect(getDraft().connector?.config).toEqual({
      mcp: { transport: "http", auth: { kind: "header" } },
    });
    expect(getDraft().connector?.validation?.errors ?? []).toEqual([]);
    expect(getDraftCredential(base.conversation_id)).toBeNull();
    _resetDraftCredentialCacheForTests();
  });

  it("does not count an auth finding the draft already carried as new when its wording changed", async () => {
    const { base, getDraft } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "Reporting MCP",
      driver: "mcp",
      environment: "prod",
      base_url: "https://reporting.acme-analytics.io/api/mcp",
      auth_type: "bearer",
      config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
    });
    // A draft recorded with a mismatched kind, under an older wording of
    // the finding.
    const draft = getDraft();
    const connector = draft.connector;
    if (!connector?.validation) throw new Error("missing connector draft");
    await base.setDraft({
      ...draft,
      connector: {
        ...connector,
        config: { mcp: { transport: "http", auth: { kind: "basic" } } },
        validation: {
          ...connector.validation,
          errors: [{ path: "config.mcp.auth.kind", message: "an older wording of this finding" }],
        },
      },
    });
    const result = await updateConnectorDraftTool.execute(base, { name: "Reporting MCP v2" });
    expect(result.ok).toBe(true);
    expect(getDraft().connector?.name).toBe("Reporting MCP v2");
  });

  it("allows auth_type changes that are not a downgrade-to-none", async () => {
    const { _resetDraftCredentialCacheForTests } = await import(
      "../../persistence/draft-credential-cache.ts"
    );
    _resetDraftCredentialCacheForTests();
    const { base } = await makeCtx();
    await updateConnectorDraftTool.execute(base, {
      name: "API",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "bearer",
    });
    // No credential cached → switching to none is allowed (just
    // editing a fresh draft).
    const result = await updateConnectorDraftTool.execute(base, { auth_type: "none" });
    expect(result.ok).toBe(true);
  });

  it("rejects any config.oauth payload with auth_mutation_not_allowed", async () => {
    // Post-fix (session 18467df2): `config.oauth` is owned by the
    // template snapshot + OAuth2 client at mint time. Letting the LLM
    // hand-edit oauth fields here is what produced the bearer-with-
    // oauth shape that strict-mode rejected at save. The earlier false
    // positive (session 3f81fb2a) on `token_endpoint` substrings
    // doesn't matter anymore — the entire oauth block is rejected
    // before SENSITIVE_KEY_PATTERN even runs. Operators rotating an
    // oauth2 client_id/secret should call authenticate_oauth.
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      config: {
        aws_region: "eu-central-1",
        oauth: {
          grant_type: "cognito_user_password",
          client_id: "abc123",
          token_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          authorization_endpoint: "https://cognito-idp.eu-central-1.amazonaws.com/",
          token_auth_method: "body",
          token_content_type: "json",
          issuer_url: "https://cognito-idp.eu-central-1.amazonaws.com",
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error_code).toBe("auth_mutation_not_allowed");
      expect(result.next_best_actions).toContain("authenticate_oauth");
    }
  });

  it("accepts non-oauth config updates (probe_endpoint, capabilities, static_headers)", async () => {
    // Non-auth config remains writable: drivers and the LLM context
    // need to tweak probe metadata, pagination defaults, and static
    // headers without touching oauth.
    const { base } = await makeCtx();
    const result = await updateConnectorDraftTool.execute(base, {
      config: {
        static_headers: { "X-API-Version": "2024-01" },
        probe_endpoint: { method: "GET", path: "/health", expected_status: [200] },
      },
    });
    expect(result.ok).toBe(true);
  });
});
