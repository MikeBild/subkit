import type { ResolvedPrincipal } from "../../auth/types.ts";
import { logger } from "../../logging/index.ts";
import { ARGS_CONFIRM_ID_KEY, ARGS_CONFIRM_KEY, type PolicyDecision } from "../../tools/policy.ts";
import type { ConfirmReason } from "../../tools/types.ts";
import { resolveAttachmentSlugsInArgs } from "../attachments.ts";
import { decideToolMode } from "../tool-policies.ts";
import {
  type InvokeCall,
  type InvokeEnv,
  persistToolResult,
  recordCall,
} from "../tools/sdk-wrap/invoke/env.ts";
import type { WrappedToolOutput } from "../tools/sdk-wrap/state.ts";
import { taskRunMarkerOf } from "../tools/sdk-wrap/task-run-guard.ts";
import { coveredArgumentsDigest, coveredArgumentsVerdict } from "./core/covered-arguments.ts";
import {
  isCoverCandidate,
  NO_PERSON_COVER,
  type PersonCover,
  recordPersonCover,
  resolvePersonCover,
} from "./gate.ts";

interface GateSeen {
  readonly kind: string;
  readonly decision?: Extract<PolicyDecision, { kind: "proceed" }>;
  readonly record: { readonly rule: ConfirmReason };
}

export async function coverForCall(
  env: InvokeEnv,
  principal: ResolvedPrincipal | null,
  args: Record<string, unknown>,
  now: Date,
): Promise<PersonCover> {
  const { inner, ctx, toolPolicies, askBeforeWriting } = env;
  if (!isCoverCandidate(inner.name)) return NO_PERSON_COVER;
  const marker = taskRunMarkerOf(ctx);
  const taskRun = marker !== null;
  const asks =
    decideToolMode({
      tool: inner.name,
      category: inner.category,
      input: args,
      overrides: toolPolicies,
      ...(askBeforeWriting ? { ask_before_writing: true } : {}),
      ...(taskRun ? { task_run: true } : {}),
    }).mode === "confirm_before_execution";
  if (!asks) return NO_PERSON_COVER;
  const covered = await resolveAttachmentSlugsInArgs(args, {
    db: env.db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    principal,
  });
  const cover = await resolvePersonCover({
    db: env.db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    principal,
    surface: ctx.surface,
    ask_before_writing: askBeforeWriting,
    task_run: taskRun,
    task_run_id: marker?.task_run_id ?? null,
    tool: inner.name,
    args: covered,
    because: env.because ?? null,
    now,
  });
  return cover.instruction_covered || cover.rule_covered
    ? { ...cover, covered_digest: coveredArgumentsDigest(covered) }
    : cover;
}

export async function refuseChangedArguments(
  env: InvokeEnv,
  call: InvokeCall,
  covered_digest: string | undefined,
  pinnedArgs: Record<string, unknown>,
): Promise<WrappedToolOutput | null> {
  const {
    [ARGS_CONFIRM_KEY]: _confirm,
    [ARGS_CONFIRM_ID_KEY]: _confirmId,
    ...executed
  } = pinnedArgs;
  if (coveredArgumentsVerdict(covered_digest, executed) !== "changed") return null;
  const { inner, ctx } = env;
  logger.warn({
    module: "conversation_tool",
    action: "person_cover.arguments_changed",
    msg: "the arguments about to run differ from the ones cleared to run without a confirmation; nothing ran",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool: inner.name,
  });
  const output = {
    ok: false,
    error_code: "covered_arguments_changed",
    message: `${inner.name} did not run: what it would send changed after it was cleared to run without a confirmation. Call it again.`,
  };
  await persistToolResult(env, call, output, "error");
  recordCall(env, call, "error");
  return { ok: false, data: output };
}

export async function settleCover(
  env: InvokeEnv,
  call: InvokeCall,
  cover: PersonCover,
  gate: GateSeen,
): Promise<WrappedToolOutput | null> {
  if (!cover.record) return null;
  const { inner, ctx, db, events } = env;
  const ranOnCover =
    gate.kind === "proceed" &&
    (gate.record.rule === "user_instruction" || gate.record.rule === "standing_rule");
  try {
    call.policyRecord = await recordPersonCover({
      db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: call.toolCallId,
      tool: inner.name,
      actor_id: ctx.actor_id ?? null,
      cover,
      resolved_rule: gate.record.rule,
      proceeded: gate.kind === "proceed",
    });
  } catch (error) {
    logger.error({
      module: "conversation_tool",
      action: "person_cover.record_failed",
      msg: "could not record why an action may run without a confirmation; nothing ran",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool: inner.name,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!ranOnCover) return null;
    const output = {
      ok: false,
      error_code: "confirmation_record_failed",
      message: `${inner.name} did not run: the reason it may run without a confirmation could not be recorded. Call it again; it will ask.`,
    };
    await persistToolResult(env, call, output, "error");
    recordCall(env, call, "error");
    return { ok: false, data: output };
  }
  if (ranOnCover && call.policyRecord?.ran_without_asking) {
    events.push({
      type: "data_part",
      data_type: "ran_without_asking",
      payload: { call_id: call.toolCallId, tool: inner.name, policy: call.policyRecord },
    });
  }
  return null;
}
