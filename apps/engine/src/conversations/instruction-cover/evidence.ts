import { and, desc, eq, gte, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversationMessages,
  conversationToolCalls,
  taskRuns,
  tasks,
  tenants,
} from "../../db/schema/index.ts";
import { DEVICE_TOOL_NAMES } from "../core/device-tools/catalog.ts";
import { INSTRUCTION_WINDOW, type UserSegment } from "./decide.ts";
import type { TaskRunFacts } from "./job.ts";

const ANSWER_TOOLS = ["ask_user_text", "ask_user_choice", "ask_user_form"];
const MESSAGE_SCAN = 40;
const OUTPUT_SCAN = 30;
const MAX_OUTPUT_BYTES = 200_000;
const SHOWN_SCAN = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assistantText(content: unknown): string | null {
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const text = (content as Record<string, unknown>).text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

export async function connectorTemplateSlug(
  db: Executor,
  tenant_id: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const id = args.connector_id;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await db
    .select({ template_slug: connectors.template_slug })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, id)))
    .limit(1);
  return row?.template_slug ?? null;
}

export interface CoverEvidence {
  readonly segments: UserSegment[];
  readonly outputs: unknown[];
  readonly shown: string[];
  readonly used_signatures: Set<string>;
  readonly timezone: string;
  readonly anchor: { readonly id: string; readonly at: Date } | null;
}

function humanText(content: unknown): string | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.kind !== undefined || record.origin !== undefined) return null;
  return typeof record.text === "string" && record.text.trim().length > 0 ? record.text : null;
}

function answerTexts(output: unknown, into: string[], depth = 0): void {
  if (depth > 4 || into.length > 40) return;
  if (typeof output === "string") {
    if (output.trim().length > 0 && output.length <= 2000) into.push(output);
    return;
  }
  if (typeof output === "number") {
    into.push(String(output));
    return;
  }
  if (Array.isArray(output)) {
    for (const item of output) answerTexts(item, into, depth + 1);
    return;
  }
  if (output && typeof output === "object") {
    for (const value of Object.values(output as Record<string, unknown>)) {
      answerTexts(value, into, depth + 1);
    }
  }
}

export async function loadCoverEvidence(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<CoverEvidence> {
  const recent = await db
    .select({
      id: conversationMessages.id,
      content: conversationMessages.content,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(MESSAGE_SCAN);
  const messages: Array<{ id: string; text: string; created_at: Date }> = [];
  for (const row of recent) {
    const text = humanText(row.content);
    if (text === null) continue;
    messages.push({ id: row.id, text, created_at: row.created_at });
    if (messages.length === INSTRUCTION_WINDOW) break;
  }
  messages.reverse();
  const latest = messages.at(-1);
  const oldest = messages[0];
  const [tenant] = await db
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  const timezone = tenant?.timezone ?? "UTC";
  if (!latest || !oldest) {
    return {
      segments: [],
      outputs: [],
      shown: [],
      used_signatures: new Set(),
      timezone,
      anchor: null,
    };
  }
  const answers = await db
    .select({
      output: conversationElicitations.output,
      decided_at: conversationElicitations.decided_at,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.status, "resolved"),
        eq(conversationElicitations.decided_by_kind, "user"),
        inArray(conversationElicitations.tool_name, ANSWER_TOOLS),
        gte(conversationElicitations.decided_at, oldest.created_at),
      ),
    )
    .orderBy(desc(conversationElicitations.decided_at))
    .limit(10);
  const timeline: Array<{ at: number; segment: UserSegment }> = messages.map((message) => ({
    at: message.created_at.getTime(),
    segment: { id: message.id, kind: "message", text: message.text },
  }));
  for (const answer of answers) {
    const texts: string[] = [];
    answerTexts(answer.output, texts);
    if (texts.length === 0) continue;
    timeline.push({
      at: answer.decided_at?.getTime() ?? 0,
      segment: { id: null, kind: "answer", text: texts.join("\n") },
    });
  }
  timeline.sort((a, b) => a.at - b.at);
  const drafts = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "assistant"),
        gte(conversationMessages.created_at, oldest.created_at),
        lt(conversationMessages.created_at, latest.created_at),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(SHOWN_SCAN);
  const shown = drafts.flatMap((row) => {
    const text = assistantText(row.content);
    return text === null ? [] : [text];
  });
  const calls = await db
    .select({ output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
        isNotNull(conversationToolCalls.output),
        notInArray(conversationToolCalls.tool, [...DEVICE_TOOL_NAMES]),
        sql`octet_length(${conversationToolCalls.output}::text) <= ${MAX_OUTPUT_BYTES}`,
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(OUTPUT_SCAN);
  const covered = await db
    .select({
      signature: sql<
        string | null
      >`${conversationToolCalls.confirmation_data} -> 'policy' ->> 'signature'`,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
        sql`${conversationToolCalls.confirmation_data} -> 'policy' ->> 'message_id' = ${latest.id}`,
      ),
    )
    .limit(200);
  const used = new Set<string>();
  for (const row of covered) {
    if (typeof row.signature === "string" && row.signature.length > 0) used.add(row.signature);
  }
  const outputs = calls.map((call) => call.output as unknown);
  return {
    segments: timeline.map((entry) => entry.segment),
    outputs,
    shown,
    used_signatures: used,
    timezone,
    anchor: {
      id: latest.id,
      at: new Date(Math.max(latest.created_at.getTime(), ...timeline.map((entry) => entry.at))),
    },
  };
}

export async function loadTaskRunFacts(
  db: Executor,
  tenant_id: string,
  task_run_id: string,
): Promise<TaskRunFacts | null> {
  if (!UUID.test(task_run_id)) return null;
  const [row] = await db
    .select({
      task_id: tasks.id,
      owner_id: tasks.owner_id,
      goal: tasks.goal,
      done_when: tasks.done_when,
      goal_edited_by: tasks.goal_edited_by,
      started_by: taskRuns.started_by,
      created_at: taskRuns.created_at,
      deadline_at: taskRuns.deadline_at,
      revision: tasks.revision,
      run_revision: taskRuns.task_revision,
    })
    .from(taskRuns)
    .innerJoin(tasks, and(eq(tasks.tenant_id, taskRuns.tenant_id), eq(tasks.id, taskRuns.task_id)))
    .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, task_run_id)))
    .limit(1);
  if (!row || row.revision !== row.run_revision) return null;
  const { revision: _revision, run_revision: _run_revision, ...facts } = row;
  return { ...facts, task_run_id };
}

export async function loadJobSignatures(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  job_id: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      signature: sql<
        string | null
      >`${conversationToolCalls.confirmation_data} -> 'policy' ->> 'signature'`,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
        sql`${conversationToolCalls.confirmation_data} -> 'policy' ->> 'job_id' = ${job_id}`,
      ),
    )
    .limit(200);
  const used = new Set<string>();
  for (const row of rows) {
    if (typeof row.signature === "string" && row.signature.length > 0) used.add(row.signature);
  }
  return used;
}
