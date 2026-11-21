import { expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  auditLog,
  conversations,
  conversationToolCalls,
  workflowExecutionAuthorities,
} from "../db/schema/index.ts";
import { EngineClient } from "../engine-client/index.ts";
import { readRunCoverage } from "../execution/run-coverage.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import type { ToolPolicies } from "../tools/types.ts";
import { createEmptyDraftDocument } from "./authoring-state/index.ts";
import { actorId, type fixture, remote, tdb } from "./conversation-run-admission-fixtures.ts";
import { tryFastPath } from "./fast-path.ts";
import { freshSignals } from "./tests/turn-signals.ts";
import { runWorkflowTool } from "./tools/engine-api/writes/run-workflow.ts";
import type { ToolContext } from "./tools/index.ts";
import { __setRunCoverageReaderForTests } from "./tools/sdk-wrap/invoke/run-coverage.ts";
import { wrapOne } from "./tools/sdk-wrap/invoke.ts";
import type { WrappedToolOutput } from "./tools/sdk-wrap/state.ts";
import { buildSyntheticWorkflowTools } from "./tools/sdk-wrap/synthetic-workflow-tools.ts";
import type { DraftDocument } from "./types.ts";

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Path = "generic" | "synthetic" | "fast";

export interface Observed {
  asked: boolean;
  writes: "live" | "held" | "none";
}

export interface Started {
  asked: boolean;
  conversation_id: string;
  data: unknown;
}

export const RUN_LIVE: Observed = { asked: false, writes: "live" };
export const RUN_HELD: Observed = { asked: false, writes: "held" };
export const ASK_FIRST: Observed = { asked: true, writes: "none" };
export const ASK_HELD: Observed = { asked: true, writes: "held" };

export const ASK_UNCOVERED: Record<Path, Observed> = {
  generic: ASK_FIRST,
  synthetic: ASK_HELD,
  fast: ASK_FIRST,
};

export function principalOf(f: Fixture): ResolvedPrincipal {
  return { provider: "test", kind: "user", id: actorId, tenant_id: f.tenant.id, roles: ["admin"] };
}

export function authorityOf(f: Fixture) {
  if (!f.authority) throw new Error("missing authority");
  return f.authority;
}

async function conversationFor(f: Fixture, toolPolicies: ToolPolicies = {}): Promise<string> {
  const [conversation] = await tdb.db
    .insert(conversations)
    .values({
      tenant_id: f.tenant.id,
      status: "active",
      tool_policies: toolPolicies,
    })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  return conversation.id;
}

function toolContext(
  f: Fixture,
  conversation_id: string,
  askBeforeWriting: boolean,
  draft: DraftDocument,
): ToolContext {
  return {
    db: tdb.db,
    tenant_id: f.tenant.id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: f.workflow.id,
    principal: principalOf(f),
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    engineClient: new EngineClient({ tenant_id: f.tenant.id, actor_id: actorId, db: tdb.db }),
    getDraft: () => draft,
    setDraft: async () => {},
    onLog: () => {},
  };
}

export function draftTargeting(f: Fixture): DraftDocument {
  const draft = createEmptyDraftDocument();
  if (!draft.summary) throw new Error("the empty draft carries no summary");
  return {
    ...draft,
    summary: {
      ...draft.summary,
      active_target: {
        kind: "workflow",
        name: f.workflow.name,
        slug: f.workflow.slug,
        id: f.workflow.id,
        environment: null,
        lifecycle_state: "persisted",
      },
    },
  };
}

export async function startGeneric(
  f: Fixture,
  askBeforeWriting: boolean,
  toolPolicies: ToolPolicies = {},
  args: Record<string, unknown> = {},
  draft: DraftDocument = createEmptyDraftDocument(),
): Promise<Started> {
  const conversation_id = await conversationFor(f);
  const execute = wrapOne(
    runWorkflowTool,
    toolContext(f, conversation_id, askBeforeWriting, draft),
    freshSignals(),
    [],
    tdb.db,
    toolPolicies,
  ).execute;
  if (!execute) throw new Error("missing generic workflow tool");
  const result = (await execute(
    { workflow: f.workflow.id, environment: "dev", ...args },
    { toolCallId: "covered-generic", messages: [], context: {} },
  )) as WrappedToolOutput;
  return { asked: result.pause !== undefined, conversation_id, data: result.data };
}

export async function startSynthetic(
  f: Fixture,
  askBeforeWriting: boolean,
  toolPolicies: ToolPolicies = {},
  args: Record<string, unknown> = {},
): Promise<Started> {
  const conversation_id = await conversationFor(f);
  const tools = await buildSyntheticWorkflowTools({
    db: tdb.db,
    principal: principalOf(f),
    ctx: toolContext(f, conversation_id, askBeforeWriting, createEmptyDraftDocument()),
    signals: freshSignals(),
    events: [],
    toolPolicies,
  });
  const execute = tools[`wf_${f.workflow.slug}`]?.execute;
  if (!execute) throw new Error("missing synthetic workflow tool");
  const result = (await execute(args, {
    toolCallId: "covered-synthetic",
    messages: [],
    context: {},
  })) as WrappedToolOutput;
  return { asked: result.pause !== undefined, conversation_id, data: result.data };
}

export async function startFast(
  f: Fixture,
  askBeforeWriting: boolean,
  toolPolicies: ToolPolicies = {},
): Promise<Started> {
  const conversation_id = await conversationFor(f, toolPolicies);
  const hit = await tryFastPath({
    db: tdb.db,
    tenant_id: f.tenant.id,
    conversation_id,
    actor_id: null,
    principal: principalOf(f),
    surface: "chat",
    answer_actor: { kind: "relay", reason: "model_tool_call" },
    user_message: `run ${f.workflow.slug}`,
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
  });
  if (!hit) throw new Error("the fast path did not take the run");
  return { asked: hit.status === "awaiting_input", conversation_id, data: hit.assistant_text };
}

export async function observe(f: Fixture, begin: () => Promise<Started>): Promise<Observed> {
  const before = remote.callCount();
  const { asked } = await begin();
  const sent = remote.callCount() - before;
  const [row] = await f.rows();
  if (!row) {
    expect(sent).toBe(0);
    return { asked, writes: "none" };
  }
  const live = row.hold_writes === false && row.execution_authority_id === f.authority?.id;
  expect(sent).toBe(live ? 1 : 0);
  return { asked, writes: live ? "live" : "held" };
}

export function start(path: Path, f: Fixture, askBeforeWriting: boolean): () => Promise<Started> {
  if (path === "generic") return () => startGeneric(f, askBeforeWriting);
  if (path === "synthetic") return () => startSynthetic(f, askBeforeWriting);
  return () => startFast(f, askBeforeWriting);
}

export async function toolCalls(f: Fixture) {
  return tdb.db
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.tenant_id, f.tenant.id));
}

export async function skipAudits(f: Fixture) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, f.tenant.id),
        eq(auditLog.action, "tool_policy.confirmation_skipped"),
      ),
    );
}

export async function revokeAuthorities(tenant_id: string): Promise<void> {
  await tdb.db
    .update(workflowExecutionAuthorities)
    .set({ revoked_at: await databaseNow(tdb.db), revoked_by: actorId })
    .where(eq(workflowExecutionAuthorities.tenant_id, tenant_id));
}

export async function withAuthorityRevokedAfterCoverageRead<T>(run: () => Promise<T>): Promise<T> {
  __setRunCoverageReaderForTests(async (db, subject) => {
    const coverage = await readRunCoverage(db, subject);
    await revokeAuthorities(subject.tenant_id);
    return coverage;
  });
  try {
    return await run();
  } finally {
    __setRunCoverageReaderForTests(null);
  }
}
