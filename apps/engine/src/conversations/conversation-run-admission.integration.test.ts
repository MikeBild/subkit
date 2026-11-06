import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { upsertCredential } from "../credentials/service.ts";
import {
  auditLog,
  connectors,
  conversationElicitations,
  conversations,
  conversationToolCalls,
  credentials,
  executionSteps,
  executions,
  tenants,
  toolApprovals,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { EngineClient } from "../engine-client/index.ts";
import { capturePreparedWorkflowReferences } from "../execution/prepared-workflow-references.ts";
import { assertToolApprovalDispatch } from "../execution/tool-approval-dispatch.ts";
import type { RequestAuthoritySnapshot } from "../execution/types.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { capturePreparedWorkflowBinding } from "../tools/prepared-workflow-approval.ts";
import { authorityConnectorDigest } from "../workflows/authority-configuration.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";
import { createEmptyDraftDocument } from "./authoring-state/index.ts";
import { resolveElicitationAndReactivate } from "./elicitations.ts";
import { type FastPathParams, tryFastPath } from "./fast-path.ts";
import { maybeAutoPersistFromElicitation } from "./persistence/auto-persist/index.ts";
import { decideToolMode, type ToolPolicies } from "./tool-policies.ts";
import { runWorkflowTool } from "./tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "./tools/index.ts";
import type { TurnSignals } from "./tools/sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./tools/sdk-wrap/synthetic-workflow-tools.ts";

let tdb: TestDb;
let remote: MockServer;
let sequence = 0;
const actorId = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  tdb = await createTestDb("fast-path-authority");
  remote = await createMockServer((_, response) => jsonResponse(response, 200, { sent: true }));
});

afterAll(async () => {
  await remote.close();
  await tdb.cleanup();
});

async function fixture(
  options: {
    maxRuns?: number;
    expired?: boolean;
    readLabel?: boolean;
    inputRequired?: boolean;
    environment?: "dev" | "prod";
    lookupRecipient?: boolean;
    container?: "loop" | "parallel";
    loopRecipients?: boolean;
    inlineEach?: boolean;
    auxiliaryCredential?: boolean;
    retryCredentials?: boolean;
    upstreamCredential?: boolean;
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
              ...(options.container === "loop"
                ? {
                    over: options.loopRecipients ? "$scope.lookup.data.recipients" : "[1]",
                    body: ["send"],
                  }
                : { branches: [["send"]] }),
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
    policy: { permissionMode?: "auto" | "ask" | "plan"; toolPolicies?: ToolPolicies } = {},
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
      permission_mode: policy.permissionMode ?? null,
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
      ...policy,
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

for (const maxRuns of [undefined, 1]) {
  test(`generic explicit live-run flag ${maxRuns ? "uses local authority once" : "cannot bypass authority"}`, async () => {
    const f = await fixture(maxRuns === undefined ? {} : { maxRuns });
    const before = remote.callCount();
    await f.runTool("generic", true);
    expect(remote.callCount()).toBe(before + (maxRuns ? 1 : 0));
    const [run] = await f.rows();
    expect(run?.hold_writes).toBe(!maxRuns);
    if (maxRuns) {
      expect(run?.execution_authority_id).toBe(f.authority?.id);
      await f.runTool("generic", true);
      expect(remote.callCount()).toBe(before + 1);
    }
  });
}

test("approved retries retain every primary and auxiliary credential actually sent", async () => {
  const f = await fixture({ auxiliaryCredential: true, retryCredentials: true });
  if (!f.primary || !f.auxiliary) throw new Error("missing retry connectors");
  const wire: Array<{ primary: string | undefined; secondary: string | string[] | undefined }> = [];
  remote.setHandler((request, response) => {
    wire.push({
      primary: request.headers.authorization,
      secondary: request.headers["x-secondary"],
    });
    if (wire.length === 1) {
      response.setHeader("retry-after", "0");
      jsonResponse(response, 429, { error: "try again" });
    } else jsonResponse(response, 200, { sent: true });
  });
  try {
    await f.runTool("synthetic");
    expect(wire).toHaveLength(0);
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(true);
    expect(wire).toEqual([
      { primary: "Bearer primary-credential-secret", secondary: "reviewed-test-token" },
      { primary: "Bearer primary-credential-secret", secondary: "reviewed-test-token" },
    ]);
    const run = (await f.rows()).find((row) => row.tool_approval_id !== null);
    if (!run) throw new Error("missing approved execution");
    expect(run.status).toBe("succeeded");
    expect(run.execution_authority_id).toBeNull();
    expect(
      Object.values(run.tool_approval_dispatches).map((dispatch) => dispatch.attempts),
    ).toEqual([2]);
    const [step] = await tdb.db
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.execution_id, run.id)),
      );
    const snapshots = step?.credential_snapshots ?? [];
    expect(snapshots).toHaveLength(4);
    for (const connectorId of [f.primary.id, f.auxiliary.id]) {
      const [credential] = await tdb.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.tenant_id, f.tenant.id),
            eq(credentials.connector_id, connectorId),
            eq(credentials.environment, "dev"),
          ),
        );
      if (!credential) throw new Error("missing retry credential");
      expect(snapshots.filter((snapshot) => snapshot.connector_id === connectorId)).toEqual([
        expect.objectContaining({
          credential_id: credential.id,
          credential_generation: credential.credential_generation,
          identity: credential.verified_identity,
        }),
        expect.objectContaining({
          credential_id: credential.id,
          credential_generation: credential.credential_generation,
          identity: credential.verified_identity,
        }),
      ]);
    }
    expect(JSON.stringify(snapshots)).not.toContain("primary-credential-secret");
    expect(JSON.stringify(snapshots)).not.toContain("reviewed-test-token");
  } finally {
    remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
  }
});

for (const rotated of [false, true]) {
  test(`auxiliary credential ${rotated ? "A-to-B-to-A requires reapproval" : "unchanged permits the exact approved dispatch"}`, async () => {
    const f = await fixture({ auxiliaryCredential: true });
    const before = remote.callCount();
    await f.runTool("synthetic");
    expect(remote.callCount()).toBe(before);
    if (rotated) {
      await f.rotateAuxiliary("changed-test-token");
      await f.rotateAuxiliary("reviewed-test-token");
    }
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(!rotated);
    expect(remote.callCount()).toBe(before + (rotated ? 0 : 1));
    if (rotated) {
      const events = await tdb.db
        .select({ reason: auditLog.reason })
        .from(auditLog)
        .where(
          and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "approval.dispatch_denied")),
        );
      expect(events.some((event) => event.reason === "prepared_request_changed")).toBe(true);
    }
  });
}

for (const rotated of [false, true]) {
  test(`credential used only by an earlier read ${rotated ? "requires a new decision after rotation" : "allows an unchanged write"}`, async () => {
    const f = await fixture({ upstreamCredential: true });
    const before = remote.callCount();
    await f.runTool("synthetic");
    expect(remote.callCount()).toBe(before + 1);
    if (rotated) {
      await f.rotateAuxiliary("changed-test-token");
      await f.rotateAuxiliary("reviewed-test-token");
    }
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(!rotated);
    expect(remote.callCount()).toBe(before + (rotated ? 2 : 3));
  });
}

test("auxiliary credential revision is rechecked after materialization before dispatch", async () => {
  const f = await fixture({ auxiliaryCredential: true });
  if (!f.auxiliary) throw new Error("missing auxiliary");
  const [credential] = await tdb.db
    .select()
    .from(credentials)
    .where(
      and(eq(credentials.tenant_id, f.tenant.id), eq(credentials.connector_id, f.auxiliary.id)),
    );
  if (!credential) throw new Error("missing credential");
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing run");
  const stepId = Object.keys(run.tool_approval_dispatches)[0];
  if (!stepId) throw new Error("missing step");
  await tdb.db
    .update(executions)
    .set({ status: "running" })
    .where(and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id)));
  await tdb.db
    .update(executionSteps)
    .set({ status: "running" })
    .where(and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.id, stepId)));
  const key = `${run.id}:${stepId}:0`;
  const snapshot: RequestAuthoritySnapshot = {
    step_id: "send",
    step_row_id: stepId,
    connector_id: null,
    requires_review: true,
    request_max_attempts: 5,
    principal_id: actorId,
    configuration_digest: authorityConnectorDigest(null),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
    referenced_authorities: await capturePreparedWorkflowReferences(
      tdb.db,
      f.tenant.id,
      "dev",
      WorkflowDefSchema.parse(f.definition),
    ),
    request: {
      method: "POST",
      url: `${remote.baseUrl}/messages`,
      headers: { Authorization: "Bearer reviewed-test-token", "Idempotency-Key": key },
      body: { recipient: "reviewed@example.test" },
      generated_idempotency: { key, page: 0 },
    },
  };
  await f.rotateAuxiliary("changed-test-token");
  await f.rotateAuxiliary("reviewed-test-token");
  const before = remote.callCount();
  await expect(
    assertToolApprovalDispatch(tdb.db, f.tenant.id, run.id, snapshot),
  ).rejects.toMatchObject({ code: "prepared_reference_credential_changed" });
  expect(remote.callCount()).toBe(before);
  expect(
    (await f.rows()).find((row) => row.id === run.id)?.tool_approval_dispatches[stepId]?.attempts,
  ).toBe(1);
});

test("a held chat approval replays its exact prepared version once", async () => {
  const f = await fixture();
  const before = remote.callCount();
  await f.runTool("synthetic");
  expect(remote.callCount()).toBe(before);
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.ok).toBe(true);
  expect(remote.callCount()).toBe(before + 1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.every((run) => run.workflow_version_id === f.version.id)).toBe(true);
  const events = await tdb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.tenant_id, f.tenant.id));
  expect(events.filter((event) => event.action === "approval.execution_bound")).toHaveLength(1);
  expect(events.filter((event) => event.action === "approval.dispatch_reserved")).toHaveLength(1);
  await f.confirmPrepared();
  expect(remote.callCount()).toBe(before + 1);
});

for (const container of [undefined, "loop", "parallel"] as const) {
  for (const changed of [false, true]) {
    test(`held approval ${changed ? "rejects a changed" : "accepts an unchanged"} recipient from a live lookup (${container ?? "direct"})`, async () => {
      let recipient = "reviewed@example.test";
      let writes = 0;
      remote.setHandler((request, response) => {
        if (request.method === "POST") writes += 1;
        jsonResponse(response, 200, { recipient, sent: true });
      });
      try {
        const f = await fixture({ lookupRecipient: true, ...(container ? { container } : {}) });
        await f.runTool("synthetic");
        expect(writes).toBe(0);
        const [preparedRun] = await f.rows();
        if (!preparedRun) throw new Error("missing held run");
        const prepared = await capturePreparedWorkflowBinding({
          db: tdb.db,
          tenant_id: f.tenant.id,
          execution_id: preparedRun.id,
          tool: `wf_${f.workflow.slug}`,
          execution_mode: "dev",
          args: {},
        });
        expect(prepared.request_reviews).toHaveLength(1);
        expect(prepared.request_reviews?.[0]?.redacted_request_json).toContain(
          "reviewed@example.test",
        );
        expect(prepared.request_reviews?.[0]?.max_attempts).toBe(5);
        expect(prepared.request_reviews?.[0]?.step).toBe(prepared.request_proofs?.[0]?.step_key);
        if (changed) recipient = "unreviewed@example.test";
        const result = await f.confirmPrepared();
        expect(result.synthetic_result?.ok).toBe(!changed);
        expect(result.synthetic_result?.data).toMatchObject({
          writes_executed: !changed,
          write_outcome: changed ? "not_dispatched" : "completed",
          write_attempts_reserved: changed ? 0 : 1,
        });
        expect(writes).toBe(changed ? 0 : 1);
        const failures = await tdb.db
          .select({ error: executionSteps.error })
          .from(executionSteps)
          .where(
            and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.status, "failed")),
          );
        if (changed) expect(failures.length).toBeGreaterThanOrEqual(1);
        else expect(failures).toHaveLength(0);
        if (changed) expect(failures[0]?.error).toMatchObject({ code: "authority_invalid" });
      } finally {
        remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
      }
    });
  }
}

for (const invalidation of ["expired", "declined"] as const) {
  test(`a ${invalidation} approval between lookup and write stops the outbound write`, async () => {
    const f = await fixture({ lookupRecipient: true });
    let invalidate = false;
    let writes = 0;
    remote.setHandler(async (request, response) => {
      if (request.method === "POST") writes += 1;
      if (invalidate && request.method === "GET") {
        const now = await databaseNow(tdb.db);
        await tdb.db
          .update(toolApprovals)
          .set(invalidation === "expired" ? { expires_at: now } : { declined_at: now })
          .where(eq(toolApprovals.tenant_id, f.tenant.id));
      }
      jsonResponse(response, 200, { recipient: "reviewed@example.test" });
    });
    try {
      await f.runTool("synthetic");
      invalidate = true;
      const result = await f.confirmPrepared();
      expect(result.synthetic_result?.ok).toBe(false);
      expect(result.synthetic_result?.data).toMatchObject({
        writes_executed: false,
        write_outcome: "not_dispatched",
      });
      expect(writes).toBe(0);
    } finally {
      remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
    }
  });
}

test("single-use execution identity and reservation counters cannot be rewritten", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing approved execution");
  const boundary = and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id));
  const [stepId, reservation] = Object.entries(run.tool_approval_dispatches)[0] ?? [];
  if (!stepId || !reservation) throw new Error("missing dispatch reservation");
  for (const change of [
    { tool_approval_id: null },
    { input: { unreviewed: true } },
    { tool_approval_dispatches: {} },
    { tool_approval_dispatches: { [stepId]: { ...reservation, attempts: 0 } } },
    { tool_approval_dispatches: { [stepId]: { ...reservation, digest: "b".repeat(64) } } },
  ])
    await expect(tdb.db.update(executions).set(change).where(boundary).execute()).rejects.toThrow();
  const { id: _id, ...copy } = run;
  const replacement = { ...copy, status: "queued" as const, tool_approval_dispatches: {} };
  await expect(tdb.db.insert(executions).values(replacement).execute()).rejects.toThrow();
  await expect(
    tdb.db
      .update(toolApprovals)
      .set({ claimed_execution_id: null })
      .where(
        and(
          eq(toolApprovals.tenant_id, f.tenant.id),
          eq(toolApprovals.id, run.tool_approval_id as string),
        ),
      )
      .execute(),
  ).rejects.toThrow();
  await tdb.db.delete(executions).where(boundary);
  const [recreated] = await tdb.db.insert(executions).values(replacement).returning();
  if (!recreated) throw new Error("missing recreated execution");
  await expect(assertToolApprovalDispatch(tdb.db, f.tenant.id, recreated.id)).rejects.toMatchObject(
    { code: "tool_approval_already_bound" },
  );
});

test("parallel dispatch reservations cannot exceed the prepared retry limit", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await f.confirmPrepared();
  const run = (await f.rows()).find((row) => row.tool_approval_id);
  if (!run) throw new Error("missing approved execution");
  const stepId = Object.keys(run.tool_approval_dispatches)[0];
  if (!stepId) throw new Error("missing dispatch reservation");
  await tdb.db
    .update(executions)
    .set({ status: "running" })
    .where(and(eq(executions.tenant_id, f.tenant.id), eq(executions.id, run.id)));
  const key = `${run.id}:${stepId}:0`;
  await tdb.db
    .update(executionSteps)
    .set({ status: "running" })
    .where(and(eq(executionSteps.tenant_id, f.tenant.id), eq(executionSteps.id, stepId)));
  const snapshot: RequestAuthoritySnapshot = {
    step_id: "send",
    step_row_id: stepId,
    connector_id: null,
    requires_review: true,
    request_max_attempts: 5,
    principal_id: actorId,
    configuration_digest: authorityConnectorDigest(null),
    credential_id: null,
    credential_revision: null,
    connection_authority: null,
    request: {
      method: "POST",
      url: `${remote.baseUrl}/messages`,
      headers: { "Idempotency-Key": key },
      body: { recipient: "reviewed@example.test" },
      generated_idempotency: { key, page: 0 },
    },
  };
  const before = remote.callCount();
  const reservations = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      assertToolApprovalDispatch(tdb.db, f.tenant.id, run.id, snapshot),
    ),
  );
  expect(reservations.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  const rejections = reservations.filter((result) => result.status === "rejected");
  expect(rejections).toHaveLength(2);
  for (const result of rejections)
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ code: "prepared_effect_exhausted" });
  expect(
    (await f.rows()).find((row) => row.id === run.id)?.tool_approval_dispatches[stepId]?.attempts,
  ).toBe(5);
  expect(remote.callCount()).toBe(before);
});

test("an unsuccessful dispatched write reports an uncertain external outcome", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  remote.setHandler((_, response) => jsonResponse(response, 503, { unavailable: true }));
  try {
    const result = await f.confirmPrepared();
    expect(result.synthetic_result?.ok).toBe(false);
    expect(result.synthetic_result?.data).toMatchObject({
      writes_executed: null,
      write_outcome: "unknown",
      write_attempts_reserved: 1,
    });
  } finally {
    remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
  }
});

test("a parent one-shot approval cannot escape through an unbound child workflow", async () => {
  const f = await fixture();
  const [child] = await tdb.db
    .insert(workflows)
    .values({ tenant_id: f.tenant.id, slug: "child-send", name: "child-send", lifecycle: "active" })
    .returning();
  if (!child) throw new Error("missing child workflow");
  const [childVersion] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: child.id,
      version: 1,
      dag: { name: "child-send", steps: f.definition.steps },
    })
    .returning();
  if (!childVersion) throw new Error("missing child version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: childVersion.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, child.id)));
  const [parentVersion] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: {
        ...f.definition,
        steps: [...f.definition.steps, { id: "call_child", kind: "call", workflow_id: child.id }],
      },
    })
    .returning();
  if (!parentVersion) throw new Error("missing parent version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: parentVersion.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  await f.runTool("synthetic");
  expect(remote.callCount()).toBe(before);
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.ok).toBe(false);
  expect(remote.callCount()).toBe(before + 1);
  expect(result.synthetic_result?.data).toMatchObject({
    writes_executed: true,
    write_outcome: "partially_completed",
  });
  const denials = await tdb.db
    .select({ reason: auditLog.reason })
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.reason, "prepared_call_unsupported")),
    );
  expect(denials).toHaveLength(1);
});

for (const inlineEach of [false, true]) {
  for (const scenario of ["unchanged", "swapped", "duplicate", "partially_changed"] as const) {
    test(`${inlineEach ? "for_each" : "loop"} approvals bind occurrence order (${scenario})`, async () => {
      let recipients = [
        { recipient: "first@example.test" },
        { recipient: scenario === "duplicate" ? "first@example.test" : "second@example.test" },
      ];
      let writes = 0;
      remote.setHandler((request, response) => {
        if (request.method === "POST") writes += 1;
        jsonResponse(response, 200, { recipients });
      });
      try {
        const f = await fixture({
          lookupRecipient: true,
          loopRecipients: true,
          ...(inlineEach ? { inlineEach: true } : { container: "loop" }),
        });
        await f.runTool("synthetic");
        expect(writes).toBe(0);
        if (scenario === "swapped") recipients = [...recipients].reverse();
        if (scenario === "partially_changed")
          recipients = [
            { recipient: "first@example.test" },
            { recipient: "unreviewed@example.test" },
          ];
        const result = await f.confirmPrepared();
        expect(result.synthetic_result?.ok).toBe(
          scenario === "unchanged" || scenario === "duplicate",
        );
        expect(writes).toBe(scenario === "swapped" ? 0 : scenario === "partially_changed" ? 1 : 2);
        expect(result.synthetic_result?.data).toMatchObject({
          writes_executed: scenario !== "swapped",
          write_attempts_reserved:
            scenario === "swapped" ? 0 : scenario === "partially_changed" ? 1 : 2,
          write_outcome:
            scenario === "swapped"
              ? "not_dispatched"
              : scenario === "partially_changed"
                ? "partially_completed"
                : "completed",
        });
      } finally {
        remote.setHandler((_, response) => jsonResponse(response, 200, { sent: true }));
      }
    });
  }
}

test("activation after a held preview invalidates the chat approval without dispatch", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [version] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "Unreviewed replacement" },
    })
    .returning();
  if (!version) throw new Error("missing replacement version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  const result = await f.confirmPrepared();
  expect(result.synthetic_result?.error_code).toBe("prepared_workflow_changed");
  expect(remote.callCount()).toBe(before);
  expect(await f.rows()).toHaveLength(1);
  const denied = await tdb.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.reason, "prepared_workflow_changed")),
    );
  expect(denied).toHaveLength(1);
});

test("an earlier-format or unreadable held approval cannot inherit the latest version", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  await tdb.db
    .update(toolApprovals)
    .set({ preview_ciphertext: null, preview_iv: null, preview_auth_tag: null })
    .where(eq(toolApprovals.tenant_id, f.tenant.id));
  const before = remote.callCount();
  expect((await f.confirmPrepared()).synthetic_result?.error_code).toBe(
    "prepared_workflow_changed",
  );
  expect(remote.callCount()).toBe(before);
});

test("prepared provenance rejects different tenant, input, environment and live runs", async () => {
  const f = await fixture();
  await f.runTool("synthetic");
  const [run] = await f.rows();
  if (!run) throw new Error("missing preparation");
  const params = {
    db: tdb.db,
    tenant_id: f.tenant.id,
    execution_id: run.id,
    tool: `wf_${f.workflow.slug}`,
    execution_mode: "dev" as const,
    args: {},
  };
  expect((await capturePreparedWorkflowBinding(params)).workflow_version_id).toBe(f.version.id);
  const other = await fixture();
  for (const changed of [
    { tenant_id: other.tenant.id },
    { args: { recipient: "other" } },
    { execution_mode: "prod" as const },
    { tool: `wf_${other.workflow.slug}` },
  ]) {
    await expect(capturePreparedWorkflowBinding({ ...params, ...changed })).rejects.toThrow();
  }
  const live = await fixture({ maxRuns: 1 });
  await live.runTool("synthetic");
  const [liveRun] = await live.rows();
  if (!liveRun) throw new Error("missing live run");
  await expect(
    capturePreparedWorkflowBinding({
      ...params,
      tenant_id: live.tenant.id,
      execution_id: liveRun.id,
      tool: `wf_${live.workflow.slug}`,
    }),
  ).rejects.toThrow();
});

for (const kind of ["generic", "synthetic"] as const) {
  test(`${kind} workflow tool cannot use an expired local authority`, async () => {
    const f = await fixture({ maxRuns: 1, expired: true });
    const before = remote.callCount();
    await f.runTool(kind);
    expect(remote.callCount()).toBe(before);
    expect(await f.reserved()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({
      hold_writes: true,
      execution_authority_id: null,
      workflow_version_id: f.version.id,
    });
  });

  test(`${kind} workflow tool automatically reserves a matching local authority`, async () => {
    const f = await fixture({ maxRuns: 2 });
    const before = remote.callCount();
    for (let index = 0; index < 2; index++) {
      const result = await f.runTool(kind);
      expect(result).toMatchObject({ ok: true });
    }
    expect(remote.callCount() - before).toBe(2);
    expect(await f.reserved()).toBe(2);
    expect((await f.rows()).every((row) => row.execution_authority_id === f.authority?.id)).toBe(
      true,
    );
    const decisions = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, f.tenant.id));
    expect(decisions).toHaveLength(0);
    if (kind === "synthetic") {
      const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
      const runs = audit.filter(
        (row) =>
          row.metadata !== null &&
          typeof row.metadata === "object" &&
          "via_action" in row.metadata &&
          row.metadata.via_action === "conversation.run_workflow",
      );
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.metadata).toMatchObject({
          workflow_version_id: f.version.id,
          execution_authority_id: f.authority?.id,
          hold_writes: false,
          writes_held: false,
        });
      }
    }
  });
}

test("production tool policy admits an existing local grant without a second gate", async () => {
  const f = await fixture({ maxRuns: 1, environment: "prod" });
  expect(
    decideToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow: f.workflow.id, environment: "prod" },
      overrides: {},
      permission_mode: "auto",
    }).mode,
  ).toBe("no_confirm");
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    execution_authority_id: f.authority?.id,
  });
});

test("an ordinary production tool start without authority remains held", async () => {
  const f = await fixture({ environment: "prod" });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({
    execution_mode: "prod",
    hold_writes: true,
    execution_authority_id: null,
  });
});

for (const permissionMode of ["ask", "plan"] as const) {
  test(`synthetic tools preserve ${permissionMode} despite an available standing grant`, async () => {
    const f = await fixture({ maxRuns: 1 });
    const before = remote.callCount();
    await f.runTool("synthetic", undefined, {
      permissionMode,
      toolPolicies: { [`wf_${f.workflow.slug}`]: "no_confirm" },
    });
    expect(remote.callCount()).toBe(before);
    expect(await f.reserved()).toBe(0);
    expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
    const pending = await tdb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tenant_id, f.tenant.id));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
  });
}

test("synthetic tools preserve an explicit per-workflow approval preference", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("synthetic", undefined, {
    permissionMode: "auto",
    toolPolicies: { [`wf_${f.workflow.slug}`]: "confirm_before_execution" },
  });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

async function retryCatalogConflict<T>(operation: () => Promise<T>): Promise<T> {
  let result = await operation();
  const busy = () =>
    JSON.stringify(result)?.includes(
      "Catalog vocabulary changed concurrently; retry the operation",
    ) === true;
  await waitFor(
    async () => {
      if (!busy()) return true;
      result = await operation();
      return !busy();
    },
    { tries: 40, sleepMs: 5, label: "catalog conflict retried before admission" },
  );
  return result;
}

test("generic, synthetic and fast-path starts share the last-run reservation after catalog conflict retries", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([
    retryCatalogConflict(() => f.runTool("generic")),
    retryCatalogConflict(() => f.runTool("synthetic")),
    retryCatalogConflict(() => f.run()),
  ]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(1);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(2);
});

test("generic workflow tool preserves an explicit preparation despite an available grant", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.hold_writes).toBe(true);
});

for (const surface of ["chat", "mcp"] as const) {
  test(`${surface}: unapproved writes are durably held, including an author-supplied read label`, async () => {
    const f = await fixture({ readLabel: true });
    const before = remote.callCount();
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).toContain("Nothing was written");
    expect(remote.callCount()).toBe(before);
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hold_writes: true,
      workflow_version_id: f.version.id,
      execution_authority_id: null,
    });
    const event = result?.events.find((entry) => entry.type === "tool_result");
    if (event?.type !== "tool_result") throw new Error("missing result");
    expect(event.output).toMatchObject({ ok: false, writes_held: true, preview: true });
    expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  });
}

test("a German start explains the held preparation in German", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.run("chat", "starte");
  expect(result?.assistant_text).toContain("Es wurde nichts geschrieben");
  expect(result?.assistant_text).toContain("Ausführungsfreigabe");
  expect(result?.assistant_text).not.toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
});

test("matching authority runs twice without a new gate, then holds the exhausted third run", async () => {
  const f = await fixture({ maxRuns: 2 });
  const before = remote.callCount();
  for (const surface of ["chat", "mcp"] as const) {
    const result = await f.run(surface);
    expect(result?.status).toBe("active");
    expect(result?.assistant_text).not.toContain("Nothing was written");
  }
  expect(remote.callCount() - before).toBe(2);
  expect(await f.reserved()).toBe(2);
  const third = await f.run();
  expect(third?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount() - before).toBe(2);
  const rows = await f.rows();
  expect(rows.filter((row) => row.execution_authority_id === f.authority?.id)).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("parallel starts cannot spend the last authorized run twice after catalog conflict retries", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  await Promise.all([
    retryCatalogConflict(() => f.run("chat")),
    retryCatalogConflict(() => f.run("mcp")),
  ]);
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.hold_writes)).toHaveLength(1);
});

test("expired authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1, expired: true });
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("revoked authority cannot release a write", async () => {
  const f = await fixture({ maxRuns: 1 });
  if (!f.authority) throw new Error("missing authority");
  await tdb.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(tdb.db), revoked_by: actorId })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, f.tenant.id),
        eq(workflowExecutionAuthorities.id, f.authority.id),
      ),
    );
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("a newer workflow version cannot inherit the old authority", async () => {
  const f = await fixture({ maxRuns: 1 });
  const [next] = await tdb.db
    .insert(workflowVersions)
    .values({
      tenant_id: f.tenant.id,
      workflow_id: f.workflow.id,
      version: 2,
      dag: { ...f.definition, description: "New revision requires its own decision" },
    })
    .returning();
  if (!next) throw new Error("missing next version");
  await tdb.db
    .update(workflows)
    .set({ current_version_id: next.id })
    .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
  const before = remote.callCount();
  expect((await f.run())?.assistant_text).toContain("Nothing was written");
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]?.workflow_version_id).toBe(next.id);
});

test("a submitted input form cannot authorize writes through execute_writes=true", async () => {
  const f = await fixture();
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.dispatched).toBe(true);
  expect(result.synthetic_result?.ok).toBe(false);
  expect(result.synthetic_result?.data).toMatchObject({
    preview: true,
    writes_held: true,
    execute_writes: false,
  });
  expect(remote.callCount()).toBe(before);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
  expect(await f.activity()).toEqual([{ outcome: "ok", approval_required: false }]);
  const approvalEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "approval.approved")));
  expect(approvalEvents).toHaveLength(0);
  const resumedEvents = await tdb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, f.tenant.id), eq(auditLog.action, "conversation.resumed")));
  expect(resumedEvents).toHaveLength(1);
  expect(resumedEvents[0]).toMatchObject({
    result: "success",
    reason: "workflow_input_submitted",
    metadata: { ok: false, preparation: true },
  });
  const calls = await tdb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.tenant_id, f.tenant.id));
  expect(calls[0]?.confirmation_state).toBeNull();
});

test("submitted input uses an existing local authority without another decision", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(true);
  expect(result.synthetic_result?.ok).toBe(true);
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
});

test("an explicit preparation form does not spend an available live run", async () => {
  const f = await fixture({ maxRuns: 1 });
  const before = remote.callCount();
  const result = await f.submitInput(false);
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
});

test("a generated missing-input form preserves an explicit preparation request", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic", false);
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({ preview: true, writes_held: true });
  expect(remote.callCount()).toBe(before);
  expect(await f.reserved()).toBe(0);
  expect((await f.rows())[0]).toMatchObject({ hold_writes: true, execution_authority_id: null });
});

test("a generated missing-input form keeps ordinary local authority discovery", async () => {
  const f = await fixture({ maxRuns: 1, inputRequired: true });
  const before = remote.callCount();
  await f.runTool("generic");
  expect(await f.rows()).toHaveLength(0);
  const result = await f.submitGeneratedInput();
  expect(result.synthetic_result?.data).toMatchObject({
    execution_authority_id: f.authority?.id,
    execute_writes: true,
  });
  expect(remote.callCount() - before).toBe(1);
  expect(await f.reserved()).toBe(1);
  const audit = await tdb.db.select().from(auditLog).where(eq(auditLog.tenant_id, f.tenant.id));
  expect(audit.filter((row) => row.action.startsWith("approval."))).toHaveLength(0);
  expect(audit.filter((row) => row.reason === "workflow_input_requested")).toHaveLength(1);
  expect(audit.filter((row) => row.reason === "workflow_input_resolved")).toHaveLength(1);
});
