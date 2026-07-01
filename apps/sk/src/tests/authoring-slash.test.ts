import { describe, expect, test } from "bun:test";
import { initialSessionState } from "@cli-core/index.ts";
import type {
  ConversationContextSnapshot,
  EngineClient,
  SetupValidationResponse,
} from "../engine-client.ts";
import type { PaneSpec } from "../repl/slash/handler.ts";
import { handleSlash } from "../repl/slash/handler.ts";

function mkCtx(client: EngineClient, conversationId = "conv-1") {
  const session = initialSessionState(conversationId);
  const panes: PaneSpec[] = [];
  return {
    panes,
    ctx: {
      client,
      profile: {
        name: "test",
        engine_url: "http://x",
        api_key: "k",
        active_tenant_id: "tenant-1",
      },
      session,
      setConversationId: () => {},
      allowedPermissions: [] as readonly string[],
      openPane: (spec: PaneSpec) => {
        panes.push(spec);
      },
    },
  };
}

describe("authoring slash panes", () => {
  test("/draft opens the draft overview pane", async () => {
    const client = {
      getConversation: async () => ({
        conversation: {} as never,
        messages: [],
        tool_calls: [],
        draft: {
          mode: "connector_authoring",
          connector: {
            name: "Local API",
            driver: "http",
            environment: "dev",
            auth_type: "none",
            latest_probe: { summary: "Probe succeeded with HTTP 200." },
          },
          workflow: { name: "new-workflow", steps: [] },
          summary: {
            readiness: "ready_to_save",
            next_action: "Save the connector draft or continue editing it.",
            missing_fields: [],
            progress_label: "Connector draft",
          },
        },
      }),
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("draft", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("text");
    expect((pane as { title: string }).title).toBe("draft overview");
    expect((pane as { lines: readonly string[] }).lines.join("\n")).toContain(
      "Probe succeeded with HTTP 200",
    );
  });

  test("/context opens the dedicated conversation context pane", async () => {
    const snapshot: ConversationContextSnapshot = {
      conversation_id: "conv-1",
      connector_id: null,
      workflow_id: null,
      draft_mode: "workflow_authoring",
      authoring_mode: "workflow",
      authoring_stage: "workflow_previewed",
      draft_summary: {
        readiness: "ready_to_probe",
        next_action: "Preview a step or the whole workflow before committing.",
        next_required_action: "Preview a step or the whole workflow before committing.",
        next_suggested_tool: "dry_run_workflow",
        missing_fields: [],
        progress_label: "1 workflow step",
        lifecycle_state: "draft_only",
        blocked_by: [],
      },
      active_target: {
        kind: "workflow",
        name: "demo-flow",
        slug: "demo-flow",
        id: null,
        environment: null,
        lifecycle_state: "draft_only",
      },
      checkpoint_statuses: [],
      stale_checkpoints: [],
      next_required_action: "Preview a step or the whole workflow before committing.",
      persisted_resources: [],
      latest_execution: null,
      latest_diagnosis: null,
      skills: {
        global: [{ id: "s1", title: "global skill" }],
        connector: [],
        workflow: [{ id: "s2", title: "workflow skill" }],
        total: 2,
      },
      messages: { total: 4, last_role: "assistant" },
      tool_calls_total: 3,
      pending_elicitations: 1,
      attachments: { total: 0, items: [] },
      latest_probe: null,
      latest_preview: null,
      workflow_version: null,
    };
    const client = {
      getConversationContextSnapshot: async () => snapshot,
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("context", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("context");
    expect((pane as { title: string }).title).toBe("conversation context");
    expect(
      (pane as { snapshot: ConversationContextSnapshot }).snapshot.skills.workflow[0]?.title,
    ).toBe("workflow skill");
    expect(
      (pane as { snapshot: ConversationContextSnapshot }).snapshot.draft_summary?.next_action,
    ).toContain("Preview a step or the whole workflow");
  });

  test("/approvals opens approval history from tool calls", async () => {
    const client = {
      getConversation: async () => ({
        conversation: {} as never,
        messages: [],
        draft: { workflow: { name: "wf", steps: [] } },
        approvals: [],
        tool_calls: [
          {
            tool: "ask_user_confirm",
            created_at: "2026-04-19T10:00:00.000Z",
            approval_required: true,
            input: { summary: "Commit the workflow?" },
            output: { confirmed: true },
          },
        ],
      }),
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("approvals", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("approval-history");
    expect(
      (pane as unknown as { items: Array<{ status: string; summary: string }> }).items[0]?.status,
    ).toBe("approved");
    expect(
      (pane as unknown as { items: Array<{ status: string; summary: string }> }).items[0]?.summary,
    ).toContain("Commit the workflow");
  });

  test("/probe run probes the connector draft directly and renders the result", async () => {
    const probed: unknown[] = [];
    const client = {
      probeConversationConnector: async (_id: string, body: unknown) => {
        probed.push(body);
        return {
          ok: true,
          tool: "probe_connector_draft",
          tool_call_id: "tc-1",
          data: {
            latest_probe: {
              ok: true,
              method: "GET",
              path: "/",
              environment: "dev",
              status_code: 200,
              duration_ms: 42,
              summary: "Probe succeeded with HTTP 200.",
            },
          },
          logs: [],
          diffs: [],
        };
      },
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("probe", ["run"], ctx);
    expect(result).toBeNull();
    expect(probed).toHaveLength(1);
    const pane = panes[0];
    expect(pane?.kind).toBe("probe-results");
    const probePane = pane as Extract<PaneSpec, { kind: "probe-results" }>;
    expect(probePane.probe.ok).toBe(true);
    expect(probePane.probe.http).toBe("200");
  });

  test("/preview run step-id dry-runs the step directly and renders the result", async () => {
    const previewed: unknown[] = [];
    const client = {
      previewConversationDraft: async (_id: string, body: unknown) => {
        previewed.push(body);
        return {
          ok: true,
          tool: "dry_run_step",
          tool_call_id: "tc-2",
          data: {
            steps_ran: 1,
            duration_ms: 120,
            summary: "Step `fetch` ran clean.",
            step_trace: [{ step_id: "fetch", kind: "request", status: "succeeded" }],
          },
          logs: [],
          diffs: [],
        };
      },
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("preview", ["run", "fetch"], ctx);
    expect(result).toBeNull();
    expect(previewed[0]).toEqual({ step_id: "fetch" });
    const pane = panes[0];
    expect(pane?.kind).toBe("preview-results");
    const previewPane = pane as Extract<PaneSpec, { kind: "preview-results" }>;
    expect(previewPane.preview.ok).toBe(true);
    expect(previewPane.preview.lines.join("\n")).toContain("fetch (request) succeeded");
  });

  test("/setup opens the dedicated setup diagnostics pane", async () => {
    const setup: SetupValidationResponse = {
      overall_status: "warn",
      summary_counts: {
        blockers: 0,
        warnings: 1,
        sections_blocked: 0,
        sections_warn: 1,
      },
      sections: {
        auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
        llm: { title: "LLM", status: "ok", issues: [], recommendations: [], values: [] },
        datastore: {
          title: "Datastore",
          status: "ok",
          issues: [],
          recommendations: [],
          values: [
            { key: "DATABASE_URL", value: "postgres://user@db:5432/subkit", status_hint: null },
          ],
        },
        storage: {
          title: "Object storage",
          status: "ok",
          issues: [],
          recommendations: [],
          values: [],
        },
        crypto: { title: "Crypto", status: "ok", issues: [], recommendations: [], values: [] },
        public_urls: {
          title: "Public URLs",
          status: "warn",
          issues: [
            {
              id: "public-base-url",
              severity: "warning",
              title: "Public base URL",
              detail: "PUBLIC_BASE_URL is not set.",
            },
          ],
          recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
          values: [{ key: "PUBLIC_BASE_URL", value: null, status_hint: "Missing" }],
        },
      },
      issues: [
        {
          id: "public-base-url",
          severity: "warning",
          title: "Public base URL",
          detail: "PUBLIC_BASE_URL is not set.",
        },
      ],
      recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
    };
    const client = {
      setupValidation: async () => setup,
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("setup", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("setup-diagnostics");
    expect((pane as { setup: SetupValidationResponse }).setup.overall_status).toBe("warn");
    expect((pane as { setup: SetupValidationResponse }).setup.sections.public_urls.status).toBe(
      "warn",
    );
  });

  test("/onboard without an interactive pane returns the REPL-only guidance", async () => {
    const client = {
      listConnectorTemplates: async () => ({
        items: [{ slug: "stripe", name: "Stripe", driver: "http", auth_type: "bearer" }],
      }),
    } as unknown as EngineClient;
    const { ctx } = mkCtx(client);
    const { openPane: _openPane, ...ctxWithoutPane } = ctx;
    const result = await handleSlash("onboard", [], ctxWithoutPane);
    expect(result).toContain("requires the Ink REPL");
  });

  test("/onboard opens the onboarding wizard pane with mapped templates", async () => {
    const client = {
      listConnectorTemplates: async () => ({
        items: [
          {
            slug: "stripe",
            name: "Stripe",
            driver: "http",
            auth_type: "bearer",
            description: "Payments",
            setup_instructions: "Create a secret key",
          },
          {
            slug: "github",
            name: "GitHub",
            driver: "http",
            auth_type: "oauth2",
            oauth: {
              authorization_url: "https://github.com/login/oauth/authorize",
              scopes: ["repo"],
            },
          },
        ],
      }),
    } as unknown as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("onboard", [], ctx);
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("onboarding-wizard");
    const wizard = pane as Extract<PaneSpec, { kind: "onboarding-wizard" }>;
    expect(wizard.templates).toHaveLength(2);
    expect(wizard.templates[1]?.oauth?.authorization_url).toContain("github.com");
    expect(typeof wizard.onProbe).toBe("function");
    expect(typeof wizard.onSave).toBe("function");
    expect(typeof wizard.onComplete).toBe("function");
  });

  test("/status includes cached setup summary when available", async () => {
    const client = {} as EngineClient;
    const { ctx, panes } = mkCtx(client);
    const result = await handleSlash("status", [], {
      ...ctx,
      statusSnapshot: {
        user: { id: "u1", email: "user@example.com", kind: "user" },
        tenant: { id: "tenant-1", slug: "tenant-alpha" },
        connectors_count: 2,
        skills_count: 3,
        tokens_today: 99,
        tokens_month: 120,
        monthly_budget_tokens: 1000,
        remaining_monthly_budget_tokens: 901,
        tokens_today_user: 12,
        tokens_month_user: 40,
        user_monthly_budget_tokens: null,
        user_remaining_monthly_budget_tokens: null,
        version: "1.10.6",
      },
      setupSnapshot: {
        overall_status: "blocked",
        summary_counts: {
          blockers: 2,
          warnings: 1,
          sections_blocked: 1,
          sections_warn: 1,
        },
        sections: {
          auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
          llm: { title: "LLM", status: "blocked", issues: [], recommendations: [], values: [] },
          datastore: {
            title: "Datastore",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          storage: {
            title: "Object storage",
            status: "warn",
            issues: [],
            recommendations: [],
            values: [],
          },
          crypto: { title: "Crypto", status: "ok", issues: [], recommendations: [], values: [] },
          public_urls: {
            title: "Public URLs",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
        },
        issues: [],
        recommendations: [],
      },
    });
    expect(result).toBeNull();
    const pane = panes[0];
    expect(pane?.kind).toBe("status");
    const rows = (
      pane as { rows: ReadonlyArray<readonly [string, string | number | null | undefined]> }
    ).rows;
    expect(
      rows.some(([label, value]) => label === "setup" && String(value).includes("blocked")),
    ).toBe(true);
  });
});
