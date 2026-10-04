import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, credentials } from "../../../db/schema/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { createConversation } from "../../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import type { DraftDocument } from "../../types.ts";
import { inspectConnectorDraftTool } from "../inspect-connector-draft.ts";
import { probeConnectorDraftTool } from "../probe-connector-draft.ts";
import { saveConnectorDraftTool } from "../save-connector-draft.ts";
import { startConnectorFromDescriptionTool } from "../start-connector-from-description.ts";
import { startConnectorFromTemplateTool } from "../start-connector-from-template.ts";
import { suggestConnectorTemplatesTool } from "../suggest-connector-templates.ts";
import { validateConnectorDraftTool } from "../validate-connector-draft.ts";

let ctx: ConversationTestCtx;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let probeRequests = 0;

beforeAll(async () => {
  ctx = await createConversationTestCtx("connector_draft_tools");
  server = Bun.serve({
    port: 0,
    // Pinned: the suite dials 127.0.0.1, so the server must bind it too.
    hostname: "127.0.0.1",
    async fetch(req) {
      probeRequests++;
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "local-probe", path: url.pathname });
      }
      if (url.pathname === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, 250)); // allow-wall-clock: simulates 250ms upstream RTT for connector-probe timeout assertions
        return Response.json({ ok: true, delayed: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await ctx.cleanup();
});

// Clean up auto-saved connectors between tests. With the
// auto-persist-on-green-probe contract, every successful probe writes
// a connector row to the DB. Two tests using the same local base_url
// otherwise trip `findReusableConnectorByUrl` in
// `start_connector_from_description`, which short-circuits with the
// prior test's saved row and never updates the draft. Cleaning the
// connectors + credentials tables between tests keeps each test
// independent.
afterEach(async () => {
  await ctx.testDb.db.delete(credentials).where(eq(credentials.tenant_id, ctx.tenant_id));
  await ctx.testDb.db.delete(connectors).where(eq(connectors.tenant_id, ctx.tenant_id));
});

async function createToolCtx() {
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      title: "connector-draft-test",
    },
    ctx.testDb.db,
  );
  let draft: DraftDocument = createEmptyDraftDocument();
  return {
    conversation_id: created.conversation.id,
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
    base: {
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
    },
  };
}

describe("connector draft tools", () => {
  for (const environment of ["dev", "prod"] as const) {
    test(`mutable ${environment} HTTP writes stay held before credentials or network`, async () => {
      const toolCtx = await createToolCtx();
      await startConnectorFromDescriptionTool.execute(toolCtx.base, {
        name: `held-${environment}`,
        driver: "http",
        environment,
        base_url: baseUrl,
        auth_type: "bearer",
      });
      const before = probeRequests;
      const result = await probeConnectorDraftTool.execute(toolCtx.base, {
        method: "POST",
        path: "/health",
        environment,
      });
      expect(result.ok).toBe(false);
      expect(result.data).toMatchObject({ held: true, error_code: "draft_write_held" });
      expect(probeRequests).toBe(before);
      expect(toolCtx.getDraft().connector?.latest_probe?.failure_code).toBe("draft_write_held");
    });
  }
  test("suggest_connector_templates returns optional matches", async () => {
    const toolCtx = await createToolCtx();
    const res = await suggestConnectorTemplatesTool.execute(toolCtx.base, {
      query: "github",
      limit: 3,
    });
    expect(res.ok).toBe(true);
    expect((res.data as { suggested: boolean }).suggested).toBe(true);
    expect(
      (res.data as { templates: Array<{ slug: string; allowed_auth_types: string[] }> })
        .templates[0]?.allowed_auth_types.length,
    ).toBeGreaterThan(0);
  });

  test("start + validate connector draft captures missing fields", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Quokka Ledger",
      description: "Private ledger sync endpoint for backoffice use",
      driver: "http",
      environment: "dev",
      auth_type: "none",
    });
    const inspected = await inspectConnectorDraftTool.execute(toolCtx.base, {});
    expect(inspected.ok).toBe(true);
    expect((inspected.data as { connector: { name: string } }).connector.name).toBe(
      "Quokka Ledger",
    );

    const validated = await validateConnectorDraftTool.execute(toolCtx.base, {});
    expect(validated.ok).toBe(false);
    const validation = (validated.data as { validation: { missing_fields: string[] } }).validation;
    expect(validation.missing_fields.some((field) => field.startsWith("base_url"))).toBe(true);
  });

  test("start_connector_from_description matches a built-in template when the description is clear", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "GitHub",
      description: "Connect GitHub repositories and issues over the GitHub API",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; template_name: string | null; auth_type: string };
      matched_template: { slug: string; score: number } | null;
    };
    expect(data.connector.template_slug).toBe("github");
    expect(data.connector.template_name).toBeTruthy();
    expect(data.connector.auth_type).toBeTruthy();
    expect(data.matched_template?.score).toBeGreaterThan(0);
  });

  test("start_connector_from_description prefers URL-pattern match over text match (AppSync Cognito)", async () => {
    // Pre-fix the LLM passing description="AWS AppSync GraphQL" + a
    // matching url got handed a generic graphql template that hardcoded
    // `auth_type=header`, forcing the operator through a credential
    // dance: ask for username+password (Cognito), reject those because
    // the draft says header-auth, ask for x-api-key. URL match now
    // wins so the operator hits `appsync-cognito` (oauth2 +
    // cognito_user_password) on the first turn.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://qjzi627ik5b4xjya4cibaba6ai.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    expect(data.connector.template_slug).toBe("appsync-cognito");
    expect(data.connector.auth_type).toBe("oauth2");
    expect(data.matched_template?.match_kind).toBe("url");
  });

  test("URL-matched oauth2 template does NOT seed config.oauth in the draft and steers to authenticate_oauth", async () => {
    // Post-fix (session 18467df2): start_connector_from_description
    // no longer writes config.oauth — that's the job of the template
    // snapshot at mint time. The bearer/PAT regression came from
    // seeding oauth into a non-oauth2 draft and tripping strict-mode
    // at save. The draft is now auth-shape-agnostic; the LLM is
    // steered to authenticate_oauth via `next_phase`.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AppSync GraphQL",
      base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: {
        template_slug: string | null;
        auth_type: string;
        config?: Record<string, unknown>;
      };
      next_phase?: { phase: string; next_suggested_tool: string };
    };
    expect(data.connector.template_slug).toBe("appsync-cognito");
    expect(data.connector.auth_type).toBe("oauth2");
    expect(data.connector.config?.oauth).toBeUndefined();
    expect(data.next_phase?.phase).toBe("authenticate_connector");
    expect(data.next_phase?.next_suggested_tool).toBe("authenticate_oauth");
  });

  test("bearer-auth GitHub draft has empty config and steers to ask_user_form", async () => {
    // Regression guard for session 18467df2: pre-fix the GitHub
    // template seeded config.oauth even when auth_type=bearer, and
    // strict-mode HttpConnectorConfig rejected the persist with
    // connector_config_invalid. Now config stays empty for bearer.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "GitHub API",
      description: "GitHub REST API for fetching repositories",
      base_url: "https://api.github.com",
      auth_type: "bearer",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: {
        template_slug: string | null;
        auth_type: string;
        config?: Record<string, unknown>;
      };
      next_phase?: { phase: string; next_suggested_tool: string };
    };
    expect(data.connector.template_slug).toBe("github");
    expect(data.connector.auth_type).toBe("bearer");
    expect(data.connector.config?.oauth).toBeUndefined();
    expect(data.next_phase?.next_suggested_tool).toBe("ask_user_form");
  });

  test("start_connector_from_description short-circuits to a saved connector with the same base_url", async () => {
    // Reproduces session 1b94070c: operator already saved an
    // appsync-graphql connector in a prior session; in a fresh
    // session pastes the same URL. Pre-fix the LLM created a NEW
    // draft (`aws-appsync-discovery`), lost the cached creds, and
    // the operator re-typed the password. Now we surface the
    // existing connector so the LLM reuses it.
    const toolCtx = await createToolCtx();
    // Persist a "prior session" connector at the same URL.
    const { createConnector } = await import("../../../connectors/service.ts");
    const saved = await createConnector(
      {
        tenant_id: toolCtx.base.tenant_id,
        input: {
          name: "Saved AppSync",
          driver: "graphql",
          environment: "dev",
          base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
          auth_type: "oauth2",
          config: {},
        },
        actor_id: null,
      },
      toolCtx.base.db,
    );

    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync Discovery", // different name — but same URL
      base_url: "https://x.appsync-api.eu-central-1.amazonaws.com/graphql",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      reused_existing: boolean;
      connector: { id: string; slug: string };
    };
    expect(data.reused_existing).toBe(true);
    expect(data.connector.id).toBe(saved.id);
    expect(data.connector.slug).toBe("saved-appsync");
  });

  test("force_new mints a SEPARATE draft on a base_url that already has a connector", async () => {
    // Reproduces conv 008e8a88: the operator already has an admin-scoped
    // connector on an upstream and explicitly wants a SECOND,
    // scope-isolated connector (its own credential) on the SAME base_url.
    // Without `force_new`, URL dedup traps the request on the existing row
    // (correct default — it preserves creds when the same connector is
    // merely re-described). With `force_new: true` the operator's explicit
    // "separate connector" intent wins: a fresh draft is minted, the
    // existing connector is untouched.
    const toolCtx = await createToolCtx();
    const { createConnector, listConnectors } = await import("../../../connectors/service.ts");
    const admin = await createConnector(
      {
        tenant_id: toolCtx.base.tenant_id,
        input: {
          name: "contentkit-admin",
          driver: "http",
          environment: "prod",
          base_url: "https://contentkit-api.example.dev",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      toolCtx.base.db,
    );

    // Sanity: without force_new, the same URL short-circuits to reuse.
    const reused = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "contentkit-radar-prod",
      base_url: "https://contentkit-api.example.dev",
      environment: "prod",
      auth_type: "bearer",
    });
    expect((reused.data as { reused_existing?: boolean }).reused_existing).toBe(true);

    // With force_new, a genuinely fresh draft is created instead.
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "contentkit-radar-prod",
      base_url: "https://contentkit-api.example.dev",
      environment: "prod",
      auth_type: "bearer",
      force_new: true,
    });
    expect(started.ok).toBe(true);
    expect((started.data as { reused_existing?: boolean }).reused_existing).toBeUndefined();

    // The draft carries the new identity, not the admin connector's.
    const inspected = await inspectConnectorDraftTool.execute(toolCtx.base, {});
    const draftConnector = (inspected.data as { connector: { name: string; slug: string } })
      .connector;
    expect(draftConnector.name).toBe("contentkit-radar-prod");
    expect(draftConnector.slug).toBe("contentkit-radar-prod");

    // The existing admin connector is untouched (draft is not yet saved).
    const { rows: saved } = await listConnectors(
      toolCtx.base.tenant_id,
      { environment: "prod" },
      toolCtx.base.db,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe(admin.id);
    expect(saved[0]?.slug).toBe("contentkit-admin");
  });

  test("URL match still wins when LLM mis-guesses auth_type as aws_sigv4", async () => {
    // Reproduces the regression in session 3f81fb2a. The LLM sees an
    // AppSync hostname and unconditionally guesses `aws_sigv4`. URL
    // match returns BOTH `appsync-cognito` and `appsync-iam`. Pre-fix
    // the guard "args.auth_type must be in URL-match's auth_options"
    // disqualified cognito (no aws_sigv4 option), fell back to text
    // match which picked `appsync-iam` — auth=aws_sigv4 baked into the
    // draft. Now we bias-by-auth-type-hint among URL matches: pick the
    // template whose auth_options accept the LLM's guess.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://sigv4test.appsync-api.us-east-1.amazonaws.com/graphql",
      environment: "dev",
      auth_type: "aws_sigv4", // mis-guess — operator actually has user+pass
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    // SigV4-compatible URL match → appsync-iam wins (the auth_type
    // hint biased the URL-match selection).
    expect(data.connector.template_slug).toBe("appsync-iam");
    expect(data.connector.auth_type).toBe("aws_sigv4");
    expect(data.matched_template?.match_kind).toBe("url");
  });

  test("URL match falls back to first candidate when LLM auth_type matches no URL template", async () => {
    // LLM mis-guesses again, this time with an auth_type that NO
    // AppSync template supports. URL match should still win — first
    // candidate (alphabetical: appsync-cognito), auth_type forced to
    // template's primary (oauth2). Operator's URL is ground truth.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "AWS AppSync GraphQL",
      description: "AWS AppSync GraphQL endpoint",
      base_url: "https://bearertest.appsync-api.ap-southeast-1.amazonaws.com/graphql",
      environment: "dev",
      auth_type: "bearer", // not in either appsync template's auth_options
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      matched_template: { slug: string; match_kind: "url" | "text" } | null;
    };
    expect(data.connector.template_slug).toBe("appsync-cognito");
    expect(data.connector.auth_type).toBe("oauth2"); // template wins, not LLM's bearer
    expect(data.matched_template?.match_kind).toBe("url");
  });

  test("start_connector_from_template reports unresolved endpoint placeholders as missing fields", async () => {
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromTemplateTool.execute(toolCtx.base, {
      template_slug: "shopify",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { required_fields: string[] };
      validation: { missing_fields: string[]; errors: Array<{ path: string; message: string }> };
    };
    expect(data.connector.required_fields).toContain("shop");
    expect(data.validation.missing_fields).toContain("base_url.shop");
    expect(data.validation.errors.some((error) => error.path === "base_url")).toBe(false);
  });

  test("start_connector_from_template steers oauth2 to authenticate_oauth and forbids access-token prompts", async () => {
    // Regression for the live LinkedIn session where the LLM, given no
    // next_phase on the template path, asked the user to "Enter your
    // LinkedIn API access token" on an oauth2 connector. The template
    // tool must return the same explicit oauth2 guidance as
    // start_connector_from_description.
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromTemplateTool.execute(toolCtx.base, {
      template_slug: "linkedin",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { auth_type: string };
      next_phase?: { phase: string; next_suggested_tool: string; hint: string };
    };
    expect(data.connector.auth_type).toBe("oauth2");
    expect(data.next_phase?.phase).toBe("authenticate_connector");
    expect(data.next_phase?.next_suggested_tool).toBe("authenticate_oauth");
    // The hint must explicitly steer away from token collection and
    // toward client_id/client_secret + the authorization-code flow.
    expect(data.next_phase?.hint).toContain("client_id");
    expect(data.next_phase?.hint).toContain("client_secret");
    expect(data.next_phase?.hint.toLowerCase()).toContain("do not ask");
    expect(data.next_phase?.hint).toContain("authenticate_oauth");
  });

  test("template URL match wins over discovery — discovery never overrides auth_type", async () => {
    // Precedence guard for the discovery-based auth recognition: when a
    // base_url matches a builtin template, the template's auth_type is
    // authoritative and the discovery branch must NOT run (it is gated on
    // `!template`). So no `recognized_auth` provenance appears and the
    // type stays the template's, never "none" or a discovered guess.
    // (The recognition mapping itself is unit-tested in
    // connectors/discovery/recognize-auth.test.ts.)
    const toolCtx = await createToolCtx();
    const started = await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "GitHub API",
      base_url: "https://api.github.com",
      environment: "dev",
    });
    expect(started.ok).toBe(true);
    const data = started.data as {
      connector: { template_slug: string | null; auth_type: string };
      recognized_auth?: unknown;
    };
    expect(data.connector.template_slug).toBe("github");
    expect(data.connector.auth_type).toBe("bearer");
    // Discovery provenance must be absent on the template-matched path.
    expect(data.recognized_auth).toBeUndefined();
  });

  test("probe_connector_draft stores the latest probe summary", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "zxqprobe",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    // Inspect + validate first — the auto-persist contract requires
    // a fresh `connector_inspected` checkpoint before the probe's
    // inline save can run.
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/health",
    });
    expect(probe.ok).toBe(true);
    const inspected = await inspectConnectorDraftTool.execute(toolCtx.base, {});
    const connector = (inspected.data as { connector: { latest_probe: { summary: string } } })
      .connector;
    expect(connector.latest_probe.summary).toContain("Probe succeeded");
  });

  test("probe_connector_draft times out cleanly and records probe_timeout", async () => {
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "zxqslow",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/slow",
      timeout_ms: 100,
    });
    expect(probe.ok).toBe(false);
    const latestProbe = (probe.data as { latest_probe: { failure_code: string; summary: string } })
      .latest_probe;
    expect(latestProbe.failure_code).toBe("probe_timeout");
    expect(latestProbe.summary).toContain("timed out");
  });

  test("green probe auto-saves the connector", async () => {
    // After a green probe, the user should never have to type "save"
    // explicitly. The probe tool fires saveConnectorAtomic inline with
    // `reason: "auto_persist_on_green_probe"` and returns the saved-
    // connector envelope directly. Pre-fix the probe ended the turn
    // with a `connector_probed` lifecycle and the user typed "what's
    // now? nothing happens!" before manually approving save.
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Auto-save API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/health",
    });
    expect(probe.ok).toBe(true);
    const data = probe.data as Record<string, unknown>;
    expect(data.auto_saved).toBe(true);
    expect(data.auto_save_reason).toBe("auto_persist_on_green_probe");
    expect(typeof data.next_prompt).toBe("string");
    // No leaked envelope markers in the visible payload.
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain("__omitted_chars");
    expect(serialised).not.toContain("__raw_ref");
  });

  test("save_connector_draft is idempotent after probe auto-saved (re-issue path)", async () => {
    // Post auto-persist contract: a green probe persists the
    // connector immediately. Calling save_connector_draft afterwards
    // hits the idempotent short-circuit and returns the existing
    // connector without writing again. The diagnostic re-issue tool
    // is still exposed for credential rotation + force-save scenarios
    // (covered by save-connector-draft-reissue.test.ts).
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "Re-issue API",
      driver: "http",
      environment: "dev",
      base_url: baseUrl,
      auth_type: "none",
    });
    await inspectConnectorDraftTool.execute(toolCtx.base, {});
    await validateConnectorDraftTool.execute(toolCtx.base, {});
    const probe = await probeConnectorDraftTool.execute(toolCtx.base, {
      method: "GET",
      path: "/health",
    });
    expect(probe.ok).toBe(true);
    expect((probe.data as { auto_saved?: boolean }).auto_saved).toBe(true);

    const reissued = await saveConnectorDraftTool.execute(toolCtx.base, {});
    expect(reissued.ok).toBe(true);
    const data = reissued.data as {
      already_persisted?: boolean;
      connector?: { id: string; display_name: string };
    };
    expect(data.already_persisted).toBe(true);
    expect(data.connector?.display_name).toBe("Re-issue API");
    expect(data.connector?.id).toBeTruthy();
  });

  test("update_connector_draft rejects config.oauth mutation with auth_mutation_not_allowed", async () => {
    // Regression guard: the LLM must not be able to hand-edit oauth
    // metadata. config.oauth is owned by the template snapshot +
    // OAuth2 client at mint time. Letting the LLM write here is what
    // produced the bearer-with-oauth shape that strict-mode rejected.
    const toolCtx = await createToolCtx();
    await startConnectorFromDescriptionTool.execute(toolCtx.base, {
      name: "GitHub API",
      base_url: "https://api.github.com",
      auth_type: "bearer",
      environment: "dev",
    });
    const { updateConnectorDraftTool } = await import("../update-connector-draft.ts");
    const rejected = await updateConnectorDraftTool.execute(toolCtx.base, {
      config: {
        oauth: {
          token_endpoint: "https://github.com/login/oauth/access_token",
        },
      },
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok === false) {
      expect(rejected.error_code).toBe("auth_mutation_not_allowed");
      expect(rejected.next_best_actions).toContain("authenticate_oauth");
    }
  });
});
