import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getConfig } from "../config/loader.ts";
import { listConfigLeaves } from "../config/walk.ts";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  executionSteps,
  executions,
} from "../db/schema/index.ts";
import { resolveOffloaded } from "../execution/offload.ts";
import { OPENAPI_INFO } from "../http/openapi.ts";
import { logRing } from "../observability/log-ring.ts";
import { can } from "../rbac/index.ts";
import { readSettingEntries } from "../runtime-config/settings-read.ts";
import { DIAGNOSTIC_COLLECTION_BYTES } from "./diagnostic-parts.ts";
import { diagnosticProjection } from "./diagnostic-projection.ts";
import { diagnosticResources } from "./diagnostic-resources.ts";
import type { ToolContext } from "./tools/index.ts";

export type DiagnosticContext = Pick<
  ToolContext,
  "db" | "tenant_id" | "conversation_id" | "principal" | "actor_id" | "getDraft" | "surface"
>;

export interface DiagnosticContextArtifact {
  name: string;
  status: "complete" | "partial" | "unavailable";
  reason?: string;
  data?: unknown;
}

function executionReferences(value: unknown, ids: Set<string>, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 12) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "execution_id" && typeof entry === "string" && /^[0-9a-f-]{36}$/.test(entry))
      ids.add(entry);
    else if (typeof entry === "object") executionReferences(entry, ids, depth + 1);
  }
}

export async function collectDiagnosticContext(
  ctx: DiagnosticContext,
  now: Date,
): Promise<DiagnosticContextArtifact[]> {
  const principal = ctx.principal;
  if (!principal || principal.tenant_id !== ctx.tenant_id || principal.id !== ctx.actor_id)
    throw new Error("Diagnostic collection requires the authenticated conversation owner");
  const [conversation] = await ctx.db
    .select({
      id: conversations.id,
      title: conversations.title,
      created_at: conversations.created_at,
      model: conversations.model,
      target_workflow_id: conversations.target_workflow_id,
      target_connector_id: conversations.target_connector_id,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, ctx.tenant_id),
        eq(conversations.id, ctx.conversation_id),
        eq(conversations.owner_id, principal.id),
      ),
    )
    .limit(1);
  if (!conversation) throw new Error("Diagnostic conversation is not available to this caller");
  const start = new Date(now.getTime() - 86_400_000);
  const config = getConfig(ctx.tenant_id);
  const settingsPermission = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission: "settings:read",
  });
  const safeConfig = settingsPermission.allow
    ? Object.fromEntries(
        readSettingEntries({ kind: "tenant", tenantId: ctx.tenant_id }).map((entry) => [
          entry.path,
          entry.value,
        ]),
      )
    : {};
  const secrets: string[] = [];
  for (const leaf of listConfigLeaves()) {
    if (leaf.path[0] === "tenants") continue;
    let value: unknown = config;
    for (const segment of leaf.path)
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[segment]
          : undefined;
    if (leaf.meta.secret) {
      if (typeof value === "string" && value.length > 0) secrets.push(value);
    }
  }
  const [messages, calls] = await Promise.all([
    ctx.db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
        tokens_in: conversationMessages.tokens_in,
        tokens_out: conversationMessages.tokens_out,
        created_at: conversationMessages.created_at,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, ctx.tenant_id),
          eq(conversationMessages.conversation_id, ctx.conversation_id),
          inArray(conversationMessages.role, ["user", "assistant", "tool"]),
        ),
      )
      .orderBy(asc(conversationMessages.created_at), asc(conversationMessages.id))
      .limit(2001),
    ctx.db
      .select({
        tool: conversationToolCalls.tool,
        input: conversationToolCalls.input,
        output: conversationToolCalls.output,
      })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, ctx.conversation_id),
        ),
      )
      .orderBy(asc(conversationToolCalls.created_at), asc(conversationToolCalls.id))
      .limit(2001),
  ]);
  const ids = new Set<string>();
  executionReferences(ctx.getDraft().state?.latest_execution, ids);
  for (const call of calls.slice(0, 2000)) executionReferences(call.output, ids);
  const candidateRuns = ids.size
    ? await ctx.db
        .select({
          id: executions.id,
          workflow_id: executions.workflow_id,
          workflow_version_id: executions.workflow_version_id,
          result_storage_uri: executions.result_storage_uri,
          result_sha256: executions.result_sha256,
          input: executions.input,
          status: executions.status,
          failure: executions.failure,
          started_at: executions.started_at,
          finished_at: executions.finished_at,
          execution_mode: executions.execution_mode,
        })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, ctx.tenant_id),
            inArray(executions.id, [...ids]),
            sql`${executions.caller_context}->>'principalId' = ${principal.id}`,
            sql`${executions.caller_context}->>'principalKind' = ${principal.kind}`,
            gte(executions.created_at, start),
            lte(executions.created_at, now),
          ),
        )
    : [];
  const runs: typeof candidateRuns = [];
  for (const run of candidateRuns) {
    const permission = await can(ctx.db, {
      tenant_id: ctx.tenant_id,
      principal,
      permission: "execution:read",
      resource: { type: "execution", id: run.id },
    });
    if (permission.allow) runs.push(run);
  }
  const runIds = runs.map((run) => run.id);
  const steps = runIds.length
    ? await ctx.db
        .select({
          execution_id: executionSteps.execution_id,
          step_key: executionSteps.step_key,
          kind: executionSteps.kind,
          status: executionSteps.status,
          input: executionSteps.input_preview,
          output: executionSteps.output_preview,
          result_storage_uri: executionSteps.result_storage_uri,
          result_sha256: executionSteps.result_sha256,
          duration_ms: executionSteps.duration_ms,
          retry_count: executionSteps.retry_count,
          error: executionSteps.error,
          started_at: executionSteps.started_at,
          finished_at: executionSteps.finished_at,
        })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, ctx.tenant_id),
            inArray(executionSteps.execution_id, runIds),
          ),
        )
        .limit(5001)
    : [];
  let resultBudget = DIAGNOSTIC_COLLECTION_BYTES;
  let unavailableResults = 0;
  async function outputFor(row: {
    result_storage_uri: string | null;
    result_sha256: string | null;
    output?: unknown;
  }) {
    if (!row.result_storage_uri) return row.output ?? null;
    try {
      const value = await resolveOffloaded(
        ctx.db,
        ctx.tenant_id,
        {
          $offloaded: true,
          storage_uri: row.result_storage_uri,
          preview: "",
          size_bytes: 0,
          ...(row.result_sha256 ? { sha256: row.result_sha256 } : {}),
        },
        undefined,
        Math.max(1, resultBudget),
      );
      resultBudget -= new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (resultBudget < 0) throw new Error("Collection limit exceeded");
      return value;
    } catch {
      unavailableResults += 1;
      return {
        unavailable: true,
        reason: "The retained result could not be read within the collection limit.",
      };
    }
  }
  const runDetails = [];
  for (const run of runs) {
    const { result_storage_uri: _uri, result_sha256: _hash, ...metadata } = run;
    runDetails.push({ ...metadata, output: await outputFor(run) });
  }
  const stepDetails = [];
  for (const step of steps.slice(0, 5000)) {
    const { result_storage_uri: _uri, result_sha256: _hash, ...metadata } = step;
    stepDetails.push({ ...metadata, output: await outputFor(step) });
  }
  const resources = await diagnosticResources(
    ctx,
    [
      ...runs.flatMap((run) => (run.workflow_id ? [run.workflow_id] : [])),
      ...(conversation.target_workflow_id ? [conversation.target_workflow_id] : []),
    ],
    runs.flatMap((run) => (run.workflow_version_id ? [run.workflow_version_id] : [])),
    conversation.target_connector_id ? [conversation.target_connector_id] : [],
  );
  const allowedRuns = new Set(runIds);
  const logs = logRing
    .tail({
      visible_to_tenant: ctx.tenant_id,
      include_engine: false,
      since_ms: start.getTime(),
      limit: logRing.capacity(),
    })
    .filter(
      (entry) =>
        entry.ts <= now.getTime() &&
        (entry.fields.conversation_id === ctx.conversation_id ||
          (typeof entry.fields.execution_id === "string" &&
            allowedRuns.has(entry.fields.execution_id))),
    );
  const artifacts: DiagnosticContextArtifact[] = [
    {
      name: "caller",
      status: "complete",
      data: {
        id: principal.id,
        kind: principal.kind,
        tenant_id: principal.tenant_id,
        product_id: principal.product_id,
        subject: principal.subject,
        email: principal.email,
        roles: principal.roles,
        scopes: principal.scopes,
        allowed_workflows: principal.allowed_workflows,
        allowed_connectors: principal.allowed_connectors,
        installation_id: principal.installation_id,
        oauth_client_id: principal.oauth_client_id,
        provider: principal.provider,
        surface: ctx.surface,
      },
    },
    {
      name: "conversation",
      status: messages.length > 2000 || calls.length > 2000 ? "partial" : "complete",
      ...(messages.length > 2000 || calls.length > 2000
        ? { reason: "The collection is limited to 2000 messages and tool calls." }
        : {}),
      data: {
        ...conversation,
        messages: messages.slice(0, 2000),
        tool_calls: calls.slice(0, 2000),
        draft: ctx.getDraft(),
      },
    },
    {
      name: "configuration",
      status: settingsPermission.allow ? "partial" : "unavailable",
      reason: settingsPermission.allow
        ? "Only readable settings of this caller's workspace are included; engine-wide and other product configuration is excluded."
        : "This caller cannot read workspace settings.",
      data: safeConfig,
    },
    ...resources,
    {
      name: "executions",
      status: "partial",
      reason: `Only readable caller-owned runs referenced by this conversation within the last 24 hours are included. Step inputs use retained previews. ${candidateRuns.length - runs.length} runs lacked read permission; ${unavailableResults} stored results were unavailable; ${Math.max(0, steps.length - 5000)} steps exceeded the collection bound.`,
      data: { runs: runDetails, steps: stepDetails },
    },
    {
      name: "logs",
      status: "partial",
      reason:
        "Only retained in-process logs linked to this conversation or its caller-owned runs are available; a complete 24-hour history cannot be guaranteed.",
      data: logs,
    },
    {
      name: "runtime",
      status: "partial",
      reason: "Current process snapshot; historical runtime samples are unavailable.",
      data: {
        uptime_s: process.uptime(),
        memory: process.memoryUsage(),
        runtime: process.versions.bun ?? process.versions.node,
        engine_version: OPENAPI_INFO.version,
        platform: process.platform,
        architecture: process.arch,
      },
    },
  ];
  return artifacts.map((artifact) => ({
    ...artifact,
    data: diagnosticProjection(artifact.data, secrets),
  }));
}
