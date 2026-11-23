import { afterAll, beforeAll, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { upsertCredential } from "../credentials/service.ts";
import {
  connectors,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  executions,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { seedMcpConnector } from "../mcp/client/test-fixtures.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import type { ToolPolicies } from "../tools/types.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { createEmptyDraftDocument } from "./authoring-state/index.ts";
import { resolveElicitationAndReactivate } from "./elicitations.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";
import { maybeAutoPersistFromElicitation } from "./persistence/auto-persist/index.ts";
import { runWorkflowTool } from "./tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnSignals } from "./tools/sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./tools/sdk-wrap/synthetic-workflow-tools.ts";

export let tdb: TestDb;
export let remote: MockServer;
export let sequence = 0;
export const actorId = "00000000-0000-4000-8000-000000000001";

export async function fixture(
  options: {
    maxRuns?: number;
    expired?: boolean;
    readLabel?: boolean;
    inputRequired?: boolean;
    environment?: "dev" | "prod";
    lookupRecipient?: boolean;
    container?: "parallel";
    loopRecipients?: boolean;
    inlineEach?: boolean;
    auxiliaryCredential?: boolean;
    retryCredentials?: boolean;
    upstreamCredential?: boolean;
    mcpResource?: boolean;
  } = {},
) {
  const environment = options.environment ?? "dev";
  const slug = `fast-boundary-${++sequence}`;
  const [tenant] = await tdb.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant");
  const [workflow] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active", is_tool: true })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const tenantId = tenant.id;
  const workflowId = workflow.id;
  const [auxiliary] =
    options.auxiliaryCredential || options.upstreamCredential
      ? await tdb.db
          .insert(connectors)
          .values({
            tenant_id: tenantId,
            slug: "auxiliary",
            display_name: "Auxiliary",
            driver: "http",
            environment,
            auth_type: "bearer",
            base_url: remote.baseUrl,
          })
          .returning()
      : [];
  async function rotateAuxiliary(token: string) {
    if (!auxiliary) throw new Error("missing auxiliary connector");
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: auxiliary.id,
        environment,
        mode: "bearer",
        value: { mode: "bearer", token },
        actor_id: null,
      },
      tdb.db,
    );
  }
  if (auxiliary) await rotateAuxiliary("reviewed-test-token");
  const [primary] = options.retryCredentials
    ? await tdb.db
        .insert(connectors)
        .values({
          tenant_id: tenantId,
          slug: "primary",
          display_name: "Primary",
          driver: "http",
          environment,
          auth_type: "bearer",
          base_url: remote.baseUrl,
        })
        .returning()
    : [];
  if (options.retryCredentials && !primary) throw new Error("missing primary connector");
  if (primary) {
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: primary.id,
        environment,
        mode: "bearer",
        value: { mode: "bearer", token: "primary-credential-secret" },
        verified_identity: {
          issuer: "https://primary.example.test",
          subject: "primary-account",
          source: "token_endpoint",
        },
        actor_id: null,
      },
      tdb.db,
    );
  }
  const resourceServer = options.mcpResource
    ? await seedMcpConnector(tdb.db, {
        tenant_id: tenantId,
        slug: `${slug}-notes`,
        display_name: "Notes server",
        environment,
        transport: "http",
        url: "https://notes.fastboundary.example.com/mcp",
      })
    : null;
  const definition = {
    name: slug,
    slug,
    ...(options.inputRequired
      ? {
          input_schema: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        }
      : {}),
    steps: [
      ...(resourceServer
        ? [
            {
              id: "notes",
              kind: "request",
              protocol: "mcp",
              connector_id: resourceServer.id,
              mcp: { operation: "read_resource", uri: "file:///notes" },
            },
          ]
        : []),
      ...(options.upstreamCredential
        ? [
            {
              id: "credential_read",
              kind: "request",
              method: "GET",
              url: `${remote.baseUrl}/credential-read`,
              headers: { Authorization: "Bearer ${cred.auxiliary.token}" },
            },
          ]
        : []),
      ...(options.lookupRecipient
        ? [{ id: "lookup", kind: "request", method: "GET", url: `${remote.baseUrl}/recipient` }]
        : []),
      ...(options.container
        ? [
            {
              id: "group",
              kind: options.container,
              branches: [["send"]],
              ...(options.lookupRecipient ? { depends_on: ["lookup"] } : {}),
            },
          ]
        : []),
      {
        id: "send",
        kind: "request",
        method: "POST",
        ...(primary
          ? {
              connector_id: primary.id,
              path: "/messages",
              headers: { "X-Secondary": "${cred.auxiliary.token}" },
              max_retries: 1,
              retry_backoff_ms: 50,
            }
          : {
              url: `${remote.baseUrl}/messages`,
              ...(options.auxiliaryCredential
                ? { headers: { Authorization: "Bearer ${cred.auxiliary.token}" } }
                : {}),
            }),
        ...(options.inlineEach
          ? { for_each: "(sourceData) => sourceData.lookup.data.recipients" }
          : {}),
        body: {
          recipient: options.loopRecipients
            ? "${item.recipient}"
            : options.lookupRecipient
              ? "${scope.lookup.data.recipient}"
              : "reviewed@example.test",
        },
        ...(options.lookupRecipient ? { depends_on: ["lookup"] } : {}),
        ...(options.upstreamCredential ? { depends_on: ["credential_read"] } : {}),
        ...(options.readLabel ? { side_effects: "read" } : {}),
      },
    ],
  };
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({ tenant_id: tenant.id, workflow_id: workflow.id, version: 1, dag: definition })
    .returning();
  if (!version) throw new Error("missing version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenant.id), eq(workflows.id, workflow.id)));
  let authority: typeof workflowExecutionAuthorities.$inferSelect | undefined;
  if (options.maxRuns !== undefined) {
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: environment,
      },
      tdb.db,
    );
    expect(preview.eligible_for_repeated_runs).toBe(true);
    const now = await databaseNow(tdb.db);
    [authority] = await tdb.db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        effect_manifest_digest: preview.digest,
        effect_manifest: { ...preview.manifest },
        execution_environment: environment,
        target_constraints: {
          targets: preview.manifest.effects.flatMap((effect) =>
            effect.target ? [effect.target] : [],
          ),
        },
        valid_from: new Date(now.getTime() - 60_000),
        valid_until: new Date(now.getTime() + (options.expired ? -1_000 : 3_600_000)),
        max_runs: options.maxRuns,
        created_by: actorId,
      })
      .returning();
    if (!authority) throw new Error("missing authority");
  }
  const principal: ResolvedPrincipal = {
    provider: "test",
    kind: "user",
    id: actorId,
    tenant_id: tenant.id,
    roles: ["admin"],
  };
  async function run(surface: "chat" | "mcp" = "chat", command = "run") {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active" })
      .returning();
    if (!conversation) throw new Error("missing conversation");
    const params: FastPathParams = {
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      principal,
      surface,
      answer_actor: { kind: "relay", reason: "model_tool_call" },
      user_message: `${command} ${slug}`,
    };
    return tryFastPath(params);
  }
  async function rows() {
    return tdb.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, tenantId), eq(executions.workflow_id, workflowId)));
  }
  async function runTool(
    kind: "generic" | "synthetic",
    executeWrites?: boolean,
    policy: {
      askBeforeWriting?: boolean;
      toolPolicies?: ToolPolicies;
    } = {},
  ) {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "active" })
      .returning();
    if (!conversation) throw new Error("missing tool conversation");
    const ctx: ToolContext = {
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      connector_id: null,
      workflow_id: workflowId,
      principal,
      ...(policy.askBeforeWriting ? { ask_before_writing: true } : {}),
      engineClient: new EngineClient({ tenant_id: tenantId, actor_id: actorId, db: tdb.db }),
      getDraft: () => createEmptyDraftDocument(),
      setDraft: async () => {},
      onLog: () => {},
    };
    if (kind === "generic") {
      return runWorkflowTool.execute(ctx, {
        workflow: workflowId,
        environment,
        ...(executeWrites === undefined ? {} : { execute_writes: executeWrites }),
      });
    }
    const signals: TurnSignals = {
      step: 0,
      toolChain: Promise.resolve(),
      toolInvocationCount: new Map(),
      toolLastErrorHash: new Map(),
      toolArgsRepeat: new Map(),
      toolValidationFingerprint: new Map(),
      toolErrorCodeRepeat: new Map(),
      totalLoopWarnings: 0,
      consecutiveFailures: 0,
      lastAssistantText: "",
      lastExecutionSuccess: null,
      pendingChildToolCallIds: [],
      pendingChildElicitationIds: [],
    };
    const tools = await buildSyntheticWorkflowTools({
      db: tdb.db,
      principal,
      ctx,
      signals,
      events: [],
      ...(policy.toolPolicies ? { toolPolicies: policy.toolPolicies } : {}),
    });
    const execute = tools[`wf_${slug}`]?.execute;
    if (!execute) throw new Error("missing synthetic workflow tool");
    return execute({}, { toolCallId: "bounded-tool-run", messages: [], context: {} });
  }
  async function submitInput(executeWrites: boolean) {
    const [conversation] = await tdb.db
      .insert(conversations)
      .values({ tenant_id: tenantId, status: "awaiting_input" })
      .returning();
    if (!conversation) throw new Error("missing form conversation");
    const [elicitation] = await tdb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: tenantId,
        conversation_id: conversation.id,
        tool_name: "ask_user_form",
        summary: "Supply workflow input",
        input: {
          commit_intent: {
            kind: "run_workflow",
            description: "Use the supplied input",
            payload: { workflow_id: workflowId, environment: "dev", execute_writes: executeWrites },
          },
        },
        output: { values: { title: "Report" } },
        status: "resolved",
      })
      .returning();
    if (!elicitation) throw new Error("missing input form");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      actor_id: null,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation,
      elicitation_output: elicitation.output,
    });
  }
  async function submitGeneratedInput() {
    const [elicitation] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, tenantId));
    if (!elicitation) throw new Error("missing generated input form");
    const output = { values: { title: "Report" } };
    const resolution = await resolveElicitationAndReactivate(
      {
        tenant_id: tenantId,
        conversation_id: elicitation.conversation_id,
        id: elicitation.id,
        output,
        decided_by: null,
      },
      tdb.db,
    );
    expect(resolution.kind).toBe("resolved");
    const [resolved] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenantId),
          eq(conversationElicitations.id, elicitation.id),
        ),
      );
    if (!resolved) throw new Error("missing resolved input form");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: resolved.conversation_id,
      actor_id: null,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation: resolved,
      elicitation_output: output,
    });
  }
  async function reserved() {
    if (!authority) throw new Error("no authority in fixture");
    const [row] = await tdb.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, tenantId),
          eq(workflowExecutionAuthorities.id, authority.id),
        ),
      );
    return row?.reserved_runs;
  }
  async function activity() {
    return tdb.db
      .select({
        outcome: conversationToolCalls.outcome,
        approval_required: conversationToolCalls.approval_required,
      })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.tenant_id, tenantId));
  }
  async function confirmPrepared() {
    const [elicitation] = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, tenantId),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
        ),
      );
    if (!elicitation) throw new Error("missing prepared approval");
    return maybeAutoPersistFromElicitation({
      db: tdb.db,
      tenant_id: tenantId,
      conversation_id: elicitation.conversation_id,
      actor_id: actorId,
      principal,
      answer_actor: { kind: "human", user_id: actorId, via: "chat" },
      elicitation,
      elicitation_output: { confirmed: true },
    });
  }
  return {
    tenant,
    workflow,
    version,
    authority,
    primary,
    definition,
    run,
    rows,
    reserved,
    activity,
    submitInput,
    submitGeneratedInput,
    runTool,
    confirmPrepared,
    rotateAuxiliary,
    auxiliary,
  };
}

export function useConversationRunAdmissionSetup(): void {
  beforeAll(async () => {
    tdb = await createTestDb("fast-path-authority");
    remote = await createMockServer((_, response) => jsonResponse(response, 200, { sent: true }));
  });

  afterAll(async () => {
    await remote.close();
    await tdb.cleanup();
  });
}
