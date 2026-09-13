// Create a new conversation row + persist the optional first user
// message. This function STOPS before the model loop — the turn runs
// via `runConversationTurn` (see ./run-turn.ts), called either inline
// by the HTTP/SSE route or in the `conversation.run-turn` pg-boss
// worker for the MCP async-Tasks path.
//
// The mock-provider plan-seeding branch handles canned tests; in
// production it is a no-op because LLM_PROVIDER isn't `mock`.

import { eq } from "drizzle-orm";

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { log } from "../../logging/logger.ts";
import { resolveAttachmentSlugsInText } from "../attachments.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { ConversationSurface } from "../lifecycle-view.ts";
import { appendMessage } from "../persist.ts";
import type { ConversationReference } from "../references.ts";
import { listBaselineSlugs, loadActivationCatalog } from "../skill-autoload.ts";
import { deriveConversationTitle } from "../title.ts";
import type { ConversationRecord } from "../types.ts";
import { normalizePermissionMode, rowToRecord } from "./shared.ts";

export interface CreateConversationParams {
  tenant_id: string;
  actor_id: string | null;
  connector_id?: string | null;
  workflow_id?: string | null;
  initial_message?: string;
  /** Objects the person @-mentioned in the first message (see `references.ts`). */
  references?: ConversationReference[] | null;
  /** Optional user-supplied memory payload (client-side SUBKIT.md). */
  memory?: string | null;
  /** Optional initial model override (sets conversations.model). */
  model?: string | null;
  /** Optional human title (sets conversations.title). */
  title?: string | null;
  /** Client-supplied permission mode — persisted on the draft session. */
  permission_mode?: "auto" | "ask" | "plan" | "yolo" | null;
  /**
   * Channel that opened this conversation, from `principalOrigin(principal)`.
   * Persisted so elicitation outcomes can be attributed to the client that
   * actually connected. Omit when the caller has no principal (internal or
   * test paths); a missing value is recorded as null, never guessed.
   */
  origin_client?: string | null;
  /** Surface the conversation is opened from — see `lifecycle-view.ts`. */
  surface?: ConversationSurface | null;
  /**
   * Start this conversation as a playground/sandbox authoring surface.
   * Durable (persisted on `draft.session.playground`, not an env flag):
   * the workflow-authoring skill is preloaded so the author_workflow /
   * dry_run_workflow / edit_workflow_patch triad is available on turn one,
   * no saved workflow is bound (the draft is pure scratch), and a commit
   * persists nothing (`commitWorkflowAtomic` returns `playground_no_persist`).
   * `hold_writes` stays on so dry-runs are safe.
   */
  playground?: boolean;
}

/**
 * The workflow-authoring skill. Preloaded into `loaded_skills` on a
 * playground conversation so its body is warm on turn one and the
 * authoring triad palette is exposed immediately (the palette already
 * auto-loads it, but seeding the recency slot puts the guidance in the
 * prompt from the first turn). Kept in sync with
 * `WORKFLOW_AUTHORING_SKILL` in `tools/authoring-palette.ts`.
 */
const PLAYGROUND_PRELOADED_SKILL = "workflow-authoring";

export interface CreateConversationResult {
  conversation: ConversationRecord;
  /**
   * The rewritten first user message (attachment slugs resolved). The
   * `conversation_messages` row is already persisted; this value is
   * handed to `runConversationTurn` so the turn does not re-insert it.
   * `null` when the conversation was created without an opening
   * message.
   */
  initial_message: string | null;
  /**
   * The `conversation_messages` row id of the persisted first user
   * message. The MCP async-Tasks handler pins this onto the `mcp_tasks`
   * row so the worker runs the turn on THIS message rather than a
   * later concurrently-appended one. `null` when no opening message.
   */
  initial_message_id: string | null;
  /** The @-mentions as sent, handed to the turn for resolution. */
  references: ConversationReference[] | null;
  /** Memory payload persisted on the row, if any. */
  user_memory: string | null;
}

/**
 * Insert a conversation row, emit the create audit, seed any canned
 * mock plan, and persist the first user-message row. Does NOT run the
 * model loop — the caller drives the turn via `runConversationTurn`.
 */
export async function createConversation(
  p: CreateConversationParams,
  exec: Db,
): Promise<CreateConversationResult> {
  const memory = typeof p.memory === "string" ? p.memory : null;
  // Resolve once for new sessions; legacy snapshots retain their stored policy.
  const initialPermissionMode = normalizePermissionMode(p.permission_mode) ?? "auto";
  const initialDraft = createEmptyDraftDocument();
  const playground = p.playground === true;
  if (initialPermissionMode || playground) {
    initialDraft.session = {
      ...(initialPermissionMode ? { permission_mode: initialPermissionMode } : {}),
      ...(playground ? { playground: true } : {}),
    };
  }
  // Seed every conversation with the baseline skills (those with a
  // `kind:"baseline"` activation rule) so the LLM has the core mental
  // model on turn one. Per-tool autoload appends domain-specific
  // skills as the conversation evolves.
  const catalog = await loadActivationCatalog(p.tenant_id, exec);
  const baselineSlugs = listBaselineSlugs(catalog);
  // A playground conversation preloads the workflow-authoring skill so
  // the authoring triad is available (and its guidance in-prompt) from
  // turn one. Deduped against the baseline set so we never seed it twice.
  const seedSlugs = playground
    ? [...new Set([...baselineSlugs, PLAYGROUND_PRELOADED_SKILL])]
    : baselineSlugs;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: p.connector_id ?? null,
      // Playground is a scratch surface — never bind a saved workflow, even
      // if a workflow_id was supplied, so a commit can never in-place update
      // a real workflow.
      target_workflow_id: playground ? null : (p.workflow_id ?? null),
      status: "active",
      draft: initialDraft,
      owner_id: p.actor_id ?? null,
      origin_client: p.origin_client ?? null,
      surface: p.surface ?? null,
      // A title handed in at create is a person's choice; the titler keeps off it.
      title_locked: typeof p.title === "string" && p.title.trim().length > 0,
      // Seed at last_turn 0 (turn_count defaults to 0; the first turn
      // becomes 1, so baseline skills satisfy the K-turn full-body window
      // immediately).
      loaded_skills: seedSlugs.map((slug) => ({ slug, last_turn: 0 })),
      ...(p.model ? { model: p.model } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(memory ? { memory } : {}),
    })
    .returning();
  assertInsertRow(row, "conversations");

  log.conversation.created({
    conversation_id: row.id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    connector_id: p.connector_id ?? null,
    workflow_id: p.workflow_id ?? null,
    has_initial_message: Boolean(p.initial_message),
    memory_included: Boolean(memory),
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_CREATED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      metadata: {
        connector_id: p.connector_id ?? null,
        workflow_id: playground ? null : (p.workflow_id ?? null),
        owner_id: p.actor_id ?? null,
        model: p.model ?? null,
        title: p.title ?? null,
        memory_included: Boolean(memory),
        playground,
      },
    },
    exec,
  );
  if (memory) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: row.id,
        result: "success",
        metadata: { bytes: memory.length },
      },
      exec,
    );
  }

  // Seed the mock provider plan for known canned flows when the initial
  // message matches. In production this is a no-op because `LLM_PROVIDER`
  // isn't `mock` and the canned plan map stays empty. Tests flip the
  // provider to `mock` in setup.
  if (p.initial_message) {
    const msg = p.initial_message;
    // The edit_workflow_patch-based canned plans assemble the whole
    // draft in one editor call. Some fixtures additionally seed minimal
    // preview evidence on the draft so the preview-before-commit gate is
    // satisfied deterministically — production is untouched (this whole
    // branch is mock-provider-only).
    let seedRepairStageEvidence = false;
    if (/open.?meteo|berlin.*weather|tomorrow.*forecast/i.test(msg)) {
      const { cannedOpenMeteoBerlinPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedOpenMeteoBerlinPlan());
      seedRepairStageEvidence = true;
    } else if (
      /subkit engine onboarding|guided connector workflow|connect the subkit engine/i.test(msg)
    ) {
      const { cannedConnectorWorkflowPlan } = await import("../../llm/mock-provider.ts");
      const { getConfig } = await import("../../config/loader.ts");
      const baseUrl = getConfig().server.public_base_url || "http://127.0.0.1:8080";
      getMockProvider().setConversePlan(row.id, cannedConnectorWorkflowPlan(baseUrl));
    } else if (/list.*users/i.test(msg)) {
      const { cannedListUsersPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(row.id, cannedListUsersPlan(p.connector_id ?? undefined));
      seedRepairStageEvidence = true;
    } else if (/workflow.*(github|git\s*hub).*(private|priv)?.*repos?/i.test(msg)) {
      const { cannedListPrivateGithubReposPlan } = await import("../../llm/mock-provider.ts");
      getMockProvider().setConversePlan(
        row.id,
        cannedListPrivateGithubReposPlan(p.connector_id ?? undefined),
      );
      seedRepairStageEvidence = true;
    }
    if (seedRepairStageEvidence && getMockProvider().conversePlans.has(row.id)) {
      await exec
        .update(conversations)
        .set({
          draft: {
            ...initialDraft,
            latest_preview: {
              ok: false,
              step_id: null,
              summary: "stage evidence (canned repair-stage fixture)",
              step_traces: [],
            },
          },
        })
        .where(eq(conversations.id, row.id));
    }
  }

  // Persist the first user-message row before the turn runs. The MCP
  // async-Tasks worker reads it back from the DB; the HTTP/SSE route
  // hands the rewritten text straight to `runConversationTurn`. Both
  // pass `user_message_persisted: true` into `runLoop` so the loop
  // does not double-insert.
  let initialMessage: string | null = null;
  let initialMessageId: string | null = null;
  if (p.initial_message) {
    const rewrite = await resolveAttachmentSlugsInText(p.initial_message, {
      db: exec,
      tenant_id: p.tenant_id,
      conversation_id: row.id,
    });
    initialMessage = rewrite.text;
    const references = p.references && p.references.length > 0 ? p.references : null;
    initialMessageId = await appendMessage(exec, p.tenant_id, row.id, "user", {
      text: initialMessage,
      ...(references ? { references } : {}),
    });
    // `appendMessage` just titled the row, but `row` was read before that
    // update. Without carrying the title over, the one response that CREATED
    // the title — the 201 body and the `conversation_started` frame built from
    // it — would still report `title: null`.
    if (row.title === null) {
      row.title = deriveConversationTitle({ text: initialMessage });
    }
  }

  return {
    conversation: rowToRecord(row),
    initial_message: initialMessage,
    initial_message_id: initialMessageId,
    references: p.references && p.references.length > 0 ? p.references : null,
    user_memory: memory,
  };
}
