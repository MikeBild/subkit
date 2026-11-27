import { z } from "@hono/zod-openapi";
import { LOCAL_CONFIRMATION_KIND } from "@shared/device/confirmation.ts";
import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import type { Db } from "../../../db/client.ts";
import { dispatchedOutcome, parseCommandArgs } from "../../../devices/core/command-args.ts";
import { conversationCommandId } from "../../../devices/core/command-id.ts";
import { localAgenticRefusal } from "../../../devices/core/run-source.ts";
import { activeAllowances } from "../../../devices/registry.ts";
import { languageFor } from "../../../identity/index.ts";
import {
  browserPartition,
  commandArgsOf,
  type DeviceToolSpec,
  isVaultTool,
} from "../../core/device-tools/catalog.ts";
import {
  bindingHash,
  confirmationQuestion,
  confirmationTarget,
} from "../../core/device-tools/confirm.ts";
import {
  filledBy,
  resolveRef,
  sameElement,
  stepRecord,
  uncertainSignatures,
} from "../../core/device-tools/history.ts";
import {
  eligibleDevices,
  personalBoundary,
  pickDevice,
  type TurnFacts,
  turnPerson,
  turnRunSource,
} from "../../core/device-tools/palette.ts";
import {
  changedUnknown,
  type DeviceToolOutput,
  deviceToolOutput,
  stoppedOutput,
} from "../../core/device-tools/result.ts";
import { parseBrowserSnapshot } from "../../core/device-tools/snapshot.ts";
import { assembleDeviceStep, type FilledValue } from "../../core/device-tools/step.ts";
import {
  loadDeviceSteps,
  loadPersonDevices,
  type PendingDeviceCommand,
  recordDeviceStep,
  recordPendingCommand,
} from "../../device-tool-store.ts";
import { elicitationRefusalResult } from "../../elicitation-refusal.ts";
import { decideDeviceTool } from "../../instruction-cover/device-decision.ts";
import { loadTaskRunFacts } from "../../instruction-cover/evidence.ts";
import {
  type BoundActionView,
  type CoverJob,
  chatCoverJob,
  type PersonCoverInput,
  recordPersonCover,
  taskCoverJob,
} from "../../instruction-cover/gate.ts";
import { deviceSignature } from "../../instruction-cover/job.ts";
import { interactivePersonRefusal } from "../../instruction-cover/session.ts";
import { requestLocalConfirmation } from "../../local-confirmation.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { taskRunMarkerOf } from "../sdk-wrap/task-run-guard.ts";
import { send, toolResult } from "./send.ts";
import { dispatchVaultPending, executeVaultTool } from "./vault.ts";

const DEVICE_ID = z.string().uuid().optional().describe("Only when several devices can do this.");

export function deviceToolInput(spec: DeviceToolSpec) {
  return spec.input.extend({ device_id: DEVICE_ID });
}

interface Turn {
  readonly facts: TurnFacts;
  readonly task_run_id: string | null;
  readonly task_id: string | null;
}

async function turnOf(db: Db, ctx: ToolContext): Promise<Turn> {
  const marker = taskRunMarkerOf(ctx);
  const principal = ctx.principal ?? null;
  if (marker) {
    const task = await loadTaskRunFacts(db, ctx.tenant_id, marker.task_run_id);
    return {
      facts: {
        person_id: principal?.id ?? null,
        interactive: false,
        task: task
          ? { owner_id: task.owner_id, started_by: task.started_by, sealed: marker.sealed === true }
          : { owner_id: "", started_by: null, sealed: true },
      },
      task_run_id: marker.task_run_id,
      task_id: marker.task_id,
    };
  }
  const interactive =
    ctx.surface === "web" &&
    interactivePersonRefusal({ principal, surface: ctx.surface, task_run: false }) === null;
  return {
    facts: { person_id: principal?.id ?? null, interactive, task: null },
    task_run_id: null,
    task_id: null,
  };
}

async function coverJob(db: Db, ctx: ToolContext, turn: Turn, now: Date): Promise<CoverJob | null> {
  const principal = ctx.principal ?? null;
  if (!principal) return null;
  const input: PersonCoverInput = {
    db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    principal,
    surface: ctx.surface,
    ask_before_writing: ctx.ask_before_writing === true,
    task_run: turn.task_run_id !== null,
    task_run_id: turn.task_run_id,
    tool: "device",
    args: {},
    because: null,
    now,
  };
  return turn.task_run_id !== null
    ? await taskCoverJob(input, principal)
    : await chatCoverJob(input);
}

function text(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

export async function dispatchPending(
  db: Db,
  p: {
    readonly tenant_id: string;
    readonly tool_call_id: string;
    readonly pending: PendingDeviceCommand;
    readonly signal: AbortSignal;
    readonly recheck: boolean;
  },
): Promise<DeviceToolOutput> {
  const { pending } = p;
  if (localAgenticRefusal(pending.source) !== null)
    return stoppedOutput("not_started_by_person", localAgenticRefusal(pending.source));
  if (pending.vault) return await dispatchVaultPending(db, p);
  if (p.recheck && pending.ref !== null && pending.tool.startsWith("browser_")) {
    const checked = await send(db, {
      ...p,
      command_id: conversationCommandId({
        owner_kind: pending.owner.kind,
        owner_id: pending.owner.id,
        tool_call_id: `${p.tool_call_id}:recheck`,
      }),
      kind: "browser.snapshot",
      args: pending.partition ? { partition: pending.partition } : {},
    });
    const page =
      checked.kind === "result" && checked.result.status === "done"
        ? parseBrowserSnapshot(checked.result.output)
        : null;
    if (!page || !sameElement(pending.element, page.refs[pending.ref]))
      return stoppedOutput("stale");
  }
  const outcome = await send(db, {
    ...p,
    command_id: pending.command_id,
    kind: pending.kind as DeviceCommandKind,
    args: pending.args,
  });
  const output = deviceToolOutput(pending.tool, dispatchedOutcome(outcome), p.tool_call_id);
  if (outcome.kind !== "refused") {
    const done =
      outcome.kind === "result" && outcome.result.status === "done" ? outcome.result.output : null;
    await recordDeviceStep(
      db,
      p.tenant_id,
      p.tool_call_id,
      stepRecord(pending, done, p.tool_call_id, changedUnknown(output)),
    );
  }
  return output;
}

function boundView(
  tool: string,
  step: ReturnType<typeof assembleDeviceStep>["step"],
): BoundActionView {
  return {
    verb: tool,
    effect_class: step.phase,
    target: step.target,
    account: null,
    recipients: step.always_ask === null && step.phase === "commit" ? [...step.values] : [],
    content_summary: step.name,
    content: null,
  };
}

export async function executeDeviceTool(
  db: Db,
  spec: DeviceToolSpec,
  ctx: ToolContext,
  rawArgs: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = deviceToolInput(spec).safeParse(rawArgs);
  if (!parsed.success)
    return {
      ok: false,
      error_code: "invalid_arguments",
      message: parsed.error.issues[0]?.message ?? "",
    };
  const input = parsed.data as Record<string, unknown>;
  const tool_call_id = ctx.tool_call_id;
  if (!tool_call_id) return toolResult(stoppedOutput("not_started_by_person"));
  const turn = await turnOf(db, ctx);
  const person = turnPerson(turn.facts);
  if (person === null) return toolResult(stoppedOutput("not_started_by_person"));
  const eligible = eligibleDevices(turn.facts, await loadPersonDevices(db, ctx.tenant_id, person));
  const picked = pickDevice(eligible, spec.capability, text(input, "device_id"));
  if (!picked.ok) return toolResult(stoppedOutput(picked.reason));
  const device_id = picked.device.device_id;
  const source = turnRunSource(turn.facts, person);
  const refusal = localAgenticRefusal(source);
  if (refusal !== null) return toolResult(stoppedOutput("not_started_by_person", refusal));
  const covering = await coverJob(db, ctx, turn, now);
  if (!covering) return toolResult(stoppedOutput("not_started_by_person"));
  const allowances = await activeAllowances(db, ctx.tenant_id, device_id);
  const job = { ...covering.job, device: personalBoundary(allowances) };
  const steps = await loadDeviceSteps(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    capability: spec.capability,
    since: job.started_at,
    except_call: tool_call_id,
  });
  if (isVaultTool(spec.name)) {
    const owner =
      turn.task_run_id !== null
        ? { kind: "task_run" as const, id: turn.task_run_id }
        : { kind: "conversation" as const, id: ctx.conversation_id };
    return await executeVaultTool(db, {
      spec,
      ctx,
      input,
      device_id,
      source,
      partition: browserPartition(
        turn.task_id !== null
          ? { kind: "task", id: turn.task_id }
          : { kind: "chat", id: ctx.conversation_id },
      ),
      owner,
      tool_call_id,
      task_run_id: turn.task_run_id,
      task_id: turn.task_id,
      request: covering.request,
      job,
      message_id: covering.message_id,
      steps,
      now,
    });
  }
  const resolved = resolveRef(spec, input, steps);
  if ("ok" in resolved) return toolResult(resolved);
  const assembled = assembleDeviceStep({
    tool: spec,
    input,
    job_id: job.id,
    element: resolved.element,
    page_origin: resolved.page_origin,
    app: resolved.app,
    filled: steps.flatMap((step) => step.filled ?? []),
    named_urls: covering.facts.urls,
  });
  const partition = browserPartition(
    turn.task_id !== null
      ? { kind: "task", id: turn.task_id }
      : { kind: "chat", id: ctx.conversation_id },
  );
  const args = parseCommandArgs(
    spec.kind,
    commandArgsOf(spec, input, {
      partition,
      window_id: resolved.window_id,
      state_hash: resolved.state_hash,
    }),
  );
  if (!args.ok)
    return { ok: false, error_code: args.code, message: args.issues.join("; ") || spec.kind };
  const owner =
    turn.task_run_id !== null
      ? { kind: "task_run" as const, id: turn.task_run_id }
      : { kind: "conversation" as const, id: ctx.conversation_id };
  const filled: FilledValue[] = filledBy(spec, input, resolved.element);
  const pending: PendingDeviceCommand = {
    tool: spec.name,
    device_id,
    command_id: conversationCommandId({ owner_kind: owner.kind, owner_id: owner.id, tool_call_id }),
    kind: spec.kind,
    args: args.args,
    owner,
    source,
    ref: resolved.ref,
    element: resolved.element,
    partition: spec.capability === "browser" ? partition : null,
    filled,
    ...(assembled.step.phase === "commit"
      ? { step_signature: deviceSignature(assembled.step) }
      : {}),
  };
  const decision = decideDeviceTool({
    request: covering.request,
    job: { ...job, uncertain_signatures: uncertainSignatures(steps) },
    assembled,
    ask_before_writing: ctx.ask_before_writing === true,
    now,
  });
  if (decision.decision === "refuse")
    return toolResult(stoppedOutput(decision.reason, decision.detail ?? null));
  if (decision.decision === "ask") {
    const locale = await languageFor(ctx.tenant_id, db, ctx.locale);
    const target = confirmationTarget(spec.name, assembled.step, locale);
    const question = confirmationQuestion(locale, target);
    await recordPendingCommand(db, ctx.tenant_id, tool_call_id, pending);
    const requested = await requestLocalConfirmation(db, {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id,
      parent_message_id: ctx.assistant_message_id ?? null,
      actor_id: ctx.actor_id,
      tool: spec.name,
      args: input,
      question,
      device: {
        device_id,
        capability: spec.capability,
        target,
        command_id: pending.command_id,
        binding_hash: bindingHash({ device_id, kind: spec.kind, args: args.args, target }),
      },
      requested_at: now,
      limits: [],
    });
    if (!requested.ok) return elicitationRefusalResult(requested.reason);
    const data = {
      pending: true,
      status: "awaiting_confirmation",
      elicitation_id: requested.elicitation_id,
      deadline_at: requested.confirmation.deadline_at,
      ask_reason: decision.reason,
    };
    return {
      ok: true,
      data,
      pause: {
        tool_name: "ask_user_confirm",
        summary: question,
        elicitation_id: requested.elicitation_id,
        input: {
          kind: LOCAL_CONFIRMATION_KIND,
          question,
          target: { tool: spec.name, args: input },
          device: requested.confirmation,
          expires_at: requested.confirmation.deadline_at,
        },
      },
    };
  }
  if (decision.by === "request") {
    await recordPersonCover({
      db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id,
      tool: spec.name,
      actor_id: ctx.actor_id,
      cover: {
        instruction_covered: true,
        rule_covered: false,
        record: {
          ran_without_asking: true,
          rule: "user_instruction",
          bound_action: boundView(spec.name, assembled.step),
          because: decision.because,
          rule_id: null,
          ask_reason: null,
          message_id: decision.because?.message_id ?? covering.message_id,
          ...(decision.signature ? { signature: decision.signature } : {}),
          job_id: job.id,
        },
      },
      resolved_rule: "user_instruction",
      proceeded: true,
    });
  }
  return toolResult(
    await dispatchPending(db, {
      tenant_id: ctx.tenant_id,
      tool_call_id,
      pending,
      signal: ctx.abortSignal ?? new AbortController().signal,
      recheck: false,
    }),
  );
}
