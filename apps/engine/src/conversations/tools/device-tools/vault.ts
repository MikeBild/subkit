import { LOCAL_CONFIRMATION_KIND } from "@shared/device/confirmation.ts";
import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import { originMatches } from "@shared/vault-validate.ts";
import { sha256HexOfText } from "../../../crypto/index.ts";
import type { Db } from "../../../db/index.ts";
import {
  conversationCommandId,
  type DeviceDispatchOutcome,
  dispatchedOutcome,
  parseCommandArgs,
} from "../../../devices/index.ts";
import { languageFor } from "../../../identity/index.ts";
import {
  consumeApprovedPayment,
  findCardForUse,
  findLoginForUse,
  mintSignInTicket,
  PAY_RESULT_NOTE,
  priorUseBlocks,
  rejectPendingPaymentOf,
  requestVaultPayment,
  SIGN_IN_RESULT_NOTE,
  settleVaultUse,
  useStatusOfOutcome,
} from "../../../vault/index.ts";
import type { DeviceToolSpec } from "../../core/device-tools/catalog.ts";
import { bindingHash, confirmationQuestion } from "../../core/device-tools/confirm.ts";
import { stepRecord } from "../../core/device-tools/history.ts";
import { deviceToolOutput, stoppedOutput } from "../../core/device-tools/result.ts";
import type { AssembledStep } from "../../core/device-tools/step.ts";
import {
  formatAmount,
  type PendingVaultUse,
  payFieldFrames,
  payPageFingerprintSource,
  sameElements,
  type VaultPage,
  vaultDeviceStep,
  vaultPage,
  vaultResultOf,
  vaultToolData,
} from "../../core/device-tools/vault.ts";
import type { DeviceStepRecord, PendingDeviceCommand } from "../../device-tool-store.ts";
import { recordDeviceStep, recordPendingCommand } from "../../device-tool-store.ts";
import { elicitationRefusalResult } from "../../elicitation-refusal.ts";
import { decideDeviceTool } from "../../instruction-cover/device-decision.ts";
import { recordPersonCover } from "../../instruction-cover/gate.ts";
import type { JobRequest, JobState } from "../../instruction-cover/job.ts";
import { requestLocalConfirmation } from "../../local-confirmation.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { send, toolResult } from "./send.ts";

type Input = Record<string, unknown>;

export interface VaultToolCall {
  readonly spec: DeviceToolSpec;
  readonly ctx: ToolContext;
  readonly input: Input;
  readonly device_id: string;
  readonly source: PendingDeviceCommand["source"];
  readonly partition: string;
  readonly owner: PendingDeviceCommand["owner"];
  readonly tool_call_id: string;
  readonly task_run_id: string | null;
  readonly task_id: string | null;
  readonly request: JobRequest;
  readonly job: JobState;
  readonly message_id: string | null;
  readonly steps: readonly DeviceStepRecord[];
  readonly now: Date;
}

function str(input: Input, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function assembled(call: VaultToolCall, origin: string): AssembledStep {
  return {
    step: vaultDeviceStep({
      tool: call.spec.name,
      job_id: call.job.id,
      origin,
      quote: str(call.input, "because"),
    }),
    other_paths: [],
    blocked: null,
  };
}

function pendingOf(
  call: VaultToolCall,
  args: Record<string, unknown>,
  vault: PendingVaultUse,
): PendingDeviceCommand {
  return {
    tool: call.spec.name,
    device_id: call.device_id,
    command_id: conversationCommandId({
      owner_kind: call.owner.kind,
      owner_id: call.owner.id,
      tool_call_id: call.tool_call_id,
    }),
    kind: call.spec.kind,
    args,
    owner: call.owner,
    source: call.source,
    ref: null,
    element: null,
    partition: call.partition,
    filled: [],
    vault,
  };
}

async function askPerson(
  db: Db,
  call: VaultToolCall,
  pending: PendingDeviceCommand,
  p: {
    readonly question: string;
    readonly target: string;
    readonly args: Input;
    readonly limit: Date | null;
    readonly reason: string;
  },
): Promise<ToolResult> {
  const { ctx } = call;
  await recordPendingCommand(db, ctx.tenant_id, call.tool_call_id, pending);
  const requested = await requestLocalConfirmation(db, {
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool_call_id: call.tool_call_id,
    parent_message_id: ctx.assistant_message_id ?? null,
    actor_id: ctx.actor_id,
    tool: call.spec.name,
    args: p.args,
    question: p.question,
    device: {
      device_id: call.device_id,
      capability: "browser",
      target: p.target,
      command_id: pending.command_id,
      binding_hash: bindingHash({
        device_id: call.device_id,
        kind: call.spec.kind,
        args: pending.args,
        target: p.target,
      }),
    },
    requested_at: call.now,
    limits: [p.limit],
  });
  if (!requested.ok) return elicitationRefusalResult(requested.reason);
  return {
    ok: true,
    data: {
      pending: true,
      status: "awaiting_confirmation",
      elicitation_id: requested.elicitation_id,
      deadline_at: requested.confirmation.deadline_at,
      ask_reason: p.reason,
    },
    pause: {
      tool_name: "ask_user_confirm",
      summary: p.question,
      elicitation_id: requested.elicitation_id,
      input: {
        kind: LOCAL_CONFIRMATION_KIND,
        question: p.question,
        target: { tool: call.spec.name, args: p.args },
        device: requested.confirmation,
        expires_at: requested.confirmation.deadline_at,
      },
    },
  };
}

function base(call: VaultToolCall, page: VaultPage, item_id: string) {
  return {
    origin: page.origin,
    item_id,
    elements: page.elements,
    actor_id: call.ctx.principal?.id ?? "",
    conversation_id: call.ctx.conversation_id,
    run_id: call.task_run_id,
    task_id: call.task_id,
  };
}

async function signIn(db: Db, call: VaultToolCall, page: VaultPage): Promise<ToolResult> {
  const { ctx, input } = call;
  const principal = ctx.principal;
  if (!principal) return toolResult(stoppedOutput("not_started_by_person"));
  const name = str(input, "vault_item") ?? "";
  const found = await findLoginForUse(db, {
    tenant_id: ctx.tenant_id,
    principal,
    name,
    environment: "prod",
  });
  if (!found.ok) return toolResult(stoppedOutput(found.code));
  if (!originMatches(found.item.origins, page.origin))
    return toolResult(stoppedOutput("origin_not_bound", page.origin));
  const blocked = await priorUseBlocks(db, {
    tenant_id: ctx.tenant_id,
    item_id: found.item.item_id,
    purpose: "sign_in",
    origin: page.origin,
    conversation_id: ctx.conversation_id,
    run_id: call.task_run_id,
  });
  if (blocked) return toolResult(stoppedOutput("already_used"));
  const kind = str(input, "kind") === "totp" ? "totp" : "password";
  const args = {
    partition: call.partition,
    snapshot_id: str(input, "snapshot_id") ?? undefined,
    origin: page.origin,
    fields: page.refs,
    kind,
  };
  const filling = Object.fromEntries(
    Object.entries(page.refs).filter(([field]) => field !== "submit"),
  );
  const pending = pendingOf(call, args, {
    ...base(call, page, found.item.item_id),
    purpose: "sign_in",
    value_digest: found.item.value_digest,
    kind,
    fields: filling,
  });
  const step = assembled(call, page.origin);
  const decision = decideDeviceTool({
    request: call.request,
    job: call.job,
    assembled: step,
    ask_before_writing: ctx.ask_before_writing === true,
    now: call.now,
  });
  if (decision.decision === "refuse")
    return toolResult(stoppedOutput(decision.reason, decision.detail ?? null));
  if (decision.decision === "ask") {
    const locale = await languageFor(ctx.tenant_id, db, ctx.locale);
    const target = `sign in · ${page.origin} · ${found.item.name}`;
    return await askPerson(db, call, pending, {
      question: confirmationQuestion(locale, target),
      target,
      args: input,
      limit: null,
      reason: decision.reason,
    });
  }
  if (decision.by === "request") {
    await recordPersonCover({
      db,
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: call.tool_call_id,
      tool: call.spec.name,
      actor_id: ctx.actor_id,
      cover: {
        instruction_covered: true,
        rule_covered: false,
        record: {
          ran_without_asking: true,
          rule: "user_instruction",
          bound_action: {
            verb: call.spec.name,
            effect_class: "commit",
            target: page.origin,
            account: null,
            recipients: [],
            content_summary: "sign in",
            content: null,
          },
          because: decision.because,
          rule_id: null,
          ask_reason: null,
          message_id: decision.because?.message_id ?? call.message_id,
          ...(decision.signature ? { signature: decision.signature } : {}),
          job_id: call.job.id,
        },
      },
      resolved_rule: "user_instruction",
      proceeded: true,
    });
  }
  return toolResult(
    await dispatchVaultPending(db, {
      tenant_id: ctx.tenant_id,
      tool_call_id: call.tool_call_id,
      pending,
      signal: ctx.abortSignal ?? new AbortController().signal,
      recheck: false,
      now: call.now,
    }),
  );
}

async function pay(db: Db, call: VaultToolCall, page: VaultPage): Promise<ToolResult> {
  const { ctx, input } = call;
  const principal = ctx.principal;
  if (!principal) return toolResult(stoppedOutput("not_started_by_person"));
  const found = await findCardForUse(db, {
    tenant_id: ctx.tenant_id,
    principal,
    card: str(input, "card") ?? "",
    environment: "prod",
  });
  if (!found.ok) return toolResult(stoppedOutput(found.code));
  const blocked = await priorUseBlocks(db, {
    tenant_id: ctx.tenant_id,
    item_id: found.item.item_id,
    purpose: "pay",
    origin: page.origin,
    conversation_id: ctx.conversation_id,
    run_id: call.task_run_id,
  });
  if (blocked) return toolResult(stoppedOutput("already_used"));
  const decision = decideDeviceTool({
    request: call.request,
    job: call.job,
    assembled: assembled(call, page.origin),
    ask_before_writing: true,
    now: call.now,
  });
  if (decision.decision === "refuse")
    return toolResult(stoppedOutput(decision.reason, decision.detail ?? null));
  const amount_minor = Number(input.amount_minor);
  const currency = str(input, "currency") ?? "";
  const page_fingerprint = sha256HexOfText(payPageFingerprintSource(page));
  const field_frames = payFieldFrames(page);
  const args = {
    partition: call.partition,
    snapshot_id: str(input, "snapshot_id") ?? undefined,
    origin: page.origin,
    page_fingerprint,
    fields: page.refs,
    field_frames,
    amount_minor,
    currency,
  };
  const draft = pendingOf(call, args, {
    ...base(call, page, found.item.item_id),
    purpose: "pay",
    payment_id: "",
  });
  const brand = String(found.item.fields.brand ?? "card");
  const last4 = String(found.item.fields.last4 ?? "");
  const payment = await requestVaultPayment(
    db,
    {
      tenant_id: ctx.tenant_id,
      owner_user_id: principal.id,
      card_item_id: found.item.item_id,
      card_value_digest: found.item.value_digest,
      card_brand: brand,
      card_last4: last4,
      origin: page.origin,
      page_fingerprint,
      fields: page.refs,
      field_frames,
      submit_ref: page.refs.submit ?? "",
      amount_minor,
      currency,
      device_id: call.device_id,
      command_id: draft.command_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: call.tool_call_id,
      task_run_id: call.task_run_id,
      execution_id: null,
    },
    call.now,
  );
  const pending: PendingDeviceCommand = {
    ...draft,
    vault: { ...base(call, page, found.item.item_id), purpose: "pay", payment_id: payment.id },
  };
  const locale = await languageFor(ctx.tenant_id, db, ctx.locale);
  const amount = formatAmount(amount_minor, currency, locale);
  const card = `${brand} •••• ${last4}`;
  const target = `pay · ${page.origin} · ${amount} · ${card}`;
  return await askPerson(db, call, pending, {
    question: confirmationQuestion(locale, target),
    target,
    args: { ...input, payment_id: payment.id },
    limit: new Date(payment.expires_at),
    reason: "always_ask",
  });
}

export async function executeVaultTool(db: Db, call: VaultToolCall): Promise<ToolResult> {
  const page = vaultPage(call.spec.name, call.input, call.steps);
  if ("ok" in page) return toolResult(page);
  return call.spec.name === "browser_pay"
    ? await pay(db, call, page)
    : await signIn(db, call, page);
}

function settledStatus(outcome: DeviceDispatchOutcome) {
  if (outcome.kind === "refused") return "failed" as const;
  if (outcome.kind === "closed") return "uncertain" as const;
  const result = outcome.result;
  if (result.status === "done") {
    const vault = vaultResultOf(result.output);
    return vault ? useStatusOfOutcome(vault.outcome, vault.filled) : ("uncertain" as const);
  }
  if (result.status === "refused" || result.status === "stopped") return "failed" as const;
  if (result.status === "failed" && result.code === "ticket_unavailable") return "failed" as const;
  return "uncertain" as const;
}

interface VaultDispatch {
  readonly tenant_id: string;
  readonly tool_call_id: string;
  readonly pending: PendingDeviceCommand;
  readonly signal: AbortSignal;
  readonly recheck: boolean;
  readonly now?: Date;
}

async function pageUnchanged(db: Db, p: VaultDispatch, vault: PendingVaultUse): Promise<boolean> {
  if (!p.recheck) return true;
  const { pending } = p;
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
  const output =
    checked.kind === "result" && checked.result.status === "done" ? checked.result.output : null;
  return output !== null && sameElements(vault.elements, output);
}

export async function dispatchVaultPending(db: Db, p: VaultDispatch) {
  const { pending } = p;
  const vault = pending.vault as PendingVaultUse;
  const now = p.now ?? new Date();
  const start = {
    tenant_id: p.tenant_id,
    actor_id: vault.actor_id || null,
    origin: vault.origin,
    conversation_id: vault.conversation_id,
    run_id: vault.run_id,
    task_id: vault.task_id,
    device_id: pending.device_id,
    command_id: pending.command_id,
  };
  let ticket: {
    readonly use_id: string;
    readonly ticket_id: string;
    readonly secrets: readonly string[];
  };
  if (vault.purpose === "sign_in") {
    if (!(await pageUnchanged(db, p, vault))) return stoppedOutput("stale");
    const minted = await mintSignInTicket(
      db,
      start,
      {
        item_id: vault.item_id,
        value_digest: vault.value_digest,
        kind: vault.kind,
        fields: vault.fields,
      },
      now,
    );
    if (!minted.ok) return stoppedOutput(minted.code);
    ticket = minted;
  } else {
    const consumed = await consumeApprovedPayment(
      db,
      { tenant_id: p.tenant_id, command_id: pending.command_id },
      now,
    );
    if (!consumed.ok) {
      await rejectPendingPaymentOf(
        db,
        { tenant_id: p.tenant_id, command_id: pending.command_id },
        now,
      );
      return stoppedOutput(consumed.code);
    }
    if (!(await pageUnchanged(db, p, vault))) {
      await settleVaultUse(db, {
        tenant_id: p.tenant_id,
        use_id: consumed.use_id,
        status: "failed",
        actor_id: start.actor_id,
      });
      return stoppedOutput("stale");
    }
    ticket = { ...consumed, secrets: [] };
  }
  const args = parseCommandArgs(pending.kind as DeviceCommandKind, {
    ...pending.args,
    secret_ticket: ticket.ticket_id,
  });
  if (!args.ok) {
    await settleVaultUse(db, {
      tenant_id: p.tenant_id,
      use_id: ticket.use_id,
      status: "failed",
      actor_id: start.actor_id,
    });
    return { ok: false as const, error_code: args.code, message: args.issues.join("; "), data: {} };
  }
  const outcome = await send(db, {
    ...p,
    command_id: pending.command_id,
    kind: pending.kind as DeviceCommandKind,
    args: args.args,
  });
  await settleVaultUse(db, {
    tenant_id: p.tenant_id,
    use_id: ticket.use_id,
    status: settledStatus(outcome),
    actor_id: start.actor_id,
  });
  const done =
    outcome.kind === "result" && outcome.result.status === "done" ? outcome.result.output : null;
  if (outcome.kind !== "refused")
    await recordDeviceStep(
      db,
      p.tenant_id,
      p.tool_call_id,
      stepRecord(pending, done, p.tool_call_id),
    );
  const result = done === null ? null : vaultResultOf(done);
  if (result === null)
    return deviceToolOutput(pending.tool, dispatchedOutcome(outcome), p.tool_call_id);
  const note = vault.purpose === "pay" ? PAY_RESULT_NOTE : SIGN_IN_RESULT_NOTE;
  return { ok: true as const, data: vaultToolData(result, note, ticket.secrets) };
}
