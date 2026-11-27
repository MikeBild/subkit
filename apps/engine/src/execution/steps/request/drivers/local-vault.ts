import { payPageFingerprintText } from "@shared/device/browser.ts";
import {
  browserSnapshotElements,
  type ElementTarget,
  pickElement,
} from "@shared/device/element-target.ts";
import type { DeviceCommandKind } from "@shared/device/protocol.ts";
import { normalizeOrigin, originMatches } from "@shared/vault-validate.ts";
import { sha256HexOfText } from "../../../../crypto/index.ts";
import { deviceStepError, parseCommandArgs, workflowCommandId } from "../../../../devices/index.ts";
import {
  consumeApprovedPayment,
  expireVaultPayments,
  findItemForDeviceOwner,
  mintSignInTicket,
  PAY_RESULT_NOTE,
  paymentStatusOf,
  priorUseBlocks,
  rejectPendingPaymentOf,
  requestVaultPayment,
  SIGN_IN_RESULT_NOTE,
  settleVaultUse,
  useStatusOfOutcome,
} from "../../../../vault/index.ts";
import type { StepResult } from "../../../types.ts";
import { elapsed, type RequestDispatch } from "./context.ts";

export interface VaultSession {
  readonly d: RequestDispatch;
  readonly device_id: string;
  readonly device_owner: string | null;
  next: number;
}

type Send = (
  kind: DeviceCommandKind,
  args: Record<string, unknown>,
) => Promise<{ ok: true; output: unknown } | { ok: false; step: StepResult }>;

interface PickedPage {
  readonly origin: string;
  readonly refs: Record<string, string>;
  readonly facts: Record<string, { role: string; name: string }>;
}

const PAYMENT_POLL_MS = 2_000;

function failure(d: RequestDispatch, code: string, detail?: string): StepResult {
  return {
    status: "failed",
    error: deviceStepError(code, detail),
    retry_count: 0,
    duration_ms: elapsed(d),
  };
}

function snapshotOrigin(output: unknown): string | null {
  const step = Object(Object(output).step) as { origin?: unknown };
  return typeof step.origin === "string" ? normalizeOrigin(step.origin) : null;
}

async function pickPage(
  session: VaultSession,
  send: Send,
  args: Record<string, unknown>,
  fields: Readonly<Record<string, ElementTarget>>,
): Promise<PickedPage | StepResult> {
  const snap = await send("browser.snapshot", {
    partition: args.partition,
    boundary: args.boundary,
  });
  if (!snap.ok) return snap.step;
  const origin = snapshotOrigin(snap.output);
  if (origin === null || origin !== normalizeOrigin(String(args.origin)))
    return failure(session.d, "origin_mismatch", origin ?? undefined);
  const entries = browserSnapshotElements(snap.output);
  const refs: Record<string, string> = {};
  const facts: Record<string, { role: string; name: string }> = {};
  for (const [field, target] of Object.entries(fields)) {
    const pick = pickElement(entries, target);
    if (!pick.ok) return failure(session.d, pick.code, field);
    const entry = entries.find((candidate) => candidate.ref === pick.ref);
    refs[field] = pick.ref;
    facts[field] = { role: entry?.role ?? "", name: entry?.name ?? "" };
  }
  return { origin, refs, facts };
}

function nextCommandId(session: VaultSession): string {
  const ctx = session.d.p.ctx;
  return workflowCommandId({
    execution_id: ctx.execution_id,
    step_id: session.d.p.step.id,
    call_path: [],
    iteration_path: ctx.evaluation_seed ?? ctx.execution_id,
    effect_index: session.next,
  });
}

function resultOf(
  session: VaultSession,
  output: unknown,
  note: string,
): { step: StepResult; status: ReturnType<typeof useStatusOfOutcome> } {
  const out = Object(output) as { filled?: unknown; submitted?: unknown; outcome?: unknown };
  const outcome =
    out.outcome === "submitted" || out.outcome === "refused" || out.outcome === "uncertain"
      ? out.outcome
      : "uncertain";
  const filled = out.filled === true;
  const status = useStatusOfOutcome(outcome, filled);
  if (outcome === "submitted")
    return {
      status,
      step: {
        status: "succeeded",
        output: { filled, submitted: out.submitted === true, outcome, note },
        retry_count: 0,
        duration_ms: elapsed(session.d),
      },
    };
  return {
    status,
    step: failure(session.d, outcome === "refused" ? "vault_fill_refused" : "delivery_uncertain"),
  };
}

async function sendWithTicket(
  session: VaultSession,
  send: Send,
  kind: DeviceCommandKind,
  args: Record<string, unknown>,
  use: { readonly use_id: string; readonly ticket_id: string },
  note: string,
): Promise<StepResult> {
  const ctx = session.d.p.ctx;
  const parsed = parseCommandArgs(kind, { ...args, secret_ticket: use.ticket_id });
  const settle = (status: Parameters<typeof settleVaultUse>[1]["status"]) =>
    settleVaultUse(ctx.db, {
      tenant_id: ctx.tenant_id,
      use_id: use.use_id,
      status,
      actor_id: session.device_owner,
    });
  if (!parsed.ok) {
    await settle("failed");
    return failure(session.d, "local_step_invalid", parsed.issues.join("; "));
  }
  const sent = await send(kind, parsed.args);
  if (!sent.ok) {
    await settle("uncertain");
    return sent.step;
  }
  const mapped = resultOf(session, sent.output, note);
  await settle(mapped.status);
  return mapped.step;
}

export async function signInStep(
  session: VaultSession,
  send: Send,
  args: Record<string, unknown>,
  fields: Readonly<Record<string, ElementTarget>>,
): Promise<StepResult> {
  const { d } = session;
  const ctx = d.p.ctx;
  if (session.device_owner === null) return failure(d, "not_started_by_person");
  const page = await pickPage(session, send, args, fields);
  if ("status" in page) return page;
  const item = await findItemForDeviceOwner(ctx.db, {
    tenant_id: ctx.tenant_id,
    owner_user_id: session.device_owner,
    reference: String(args.vault_item),
    kind: "login",
    environment: ctx.execution_mode,
  });
  if (!item) return failure(d, "vault_item_not_found");
  if (!originMatches(item.origins, page.origin)) return failure(d, "origin_not_bound", page.origin);
  if (
    await priorUseBlocks(ctx.db, {
      tenant_id: ctx.tenant_id,
      item_id: item.item_id,
      purpose: "sign_in",
      origin: page.origin,
      conversation_id: null,
      run_id: ctx.execution_id,
    })
  )
    return failure(d, "already_used");
  const kind = args.kind === "totp" ? "totp" : "password";
  const minted = await mintSignInTicket(
    ctx.db,
    {
      tenant_id: ctx.tenant_id,
      actor_id: session.device_owner,
      origin: page.origin,
      conversation_id: null,
      run_id: ctx.execution_id,
      task_id: null,
      device_id: session.device_id,
      command_id: nextCommandId(session),
    },
    {
      item_id: item.item_id,
      value_digest: item.value_digest,
      kind,
      fields: Object.fromEntries(Object.entries(page.refs).filter(([field]) => field !== "submit")),
    },
    new Date(d.clock.now()),
  );
  if (!minted.ok) return failure(d, minted.code);
  return await sendWithTicket(
    session,
    send,
    "browser.sign_in",
    {
      partition: args.partition,
      boundary: args.boundary,
      origin: page.origin,
      fields: page.refs,
      kind,
    },
    minted,
    SIGN_IN_RESULT_NOTE,
  );
}

async function awaitApproval(
  session: VaultSession,
  payment: { readonly id: string; readonly expires_at: string },
): Promise<boolean> {
  const { d } = session;
  const ctx = d.p.ctx;
  const until = Date.parse(payment.expires_at);
  while (!d.signal.aborted && d.clock.now() < until) {
    const status = await paymentStatusOf(ctx.db, ctx.tenant_id, payment.id);
    if (status === "approved") return true;
    if (status !== "pending") return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, PAYMENT_POLL_MS);
      function done() {
        clearTimeout(timer);
        d.signal.removeEventListener("abort", done);
        resolve();
      }
      d.signal.addEventListener("abort", done);
    });
  }
  return false;
}

export async function payStep(
  session: VaultSession,
  send: Send,
  args: Record<string, unknown>,
  fields: Readonly<Record<string, ElementTarget>>,
): Promise<StepResult> {
  const { d } = session;
  const ctx = d.p.ctx;
  if (session.device_owner === null) return failure(d, "not_started_by_person");
  const page = await pickPage(session, send, args, fields);
  if ("status" in page) return page;
  const card = await findItemForDeviceOwner(ctx.db, {
    tenant_id: ctx.tenant_id,
    owner_user_id: session.device_owner,
    reference: String(args.card),
    kind: "card",
    environment: ctx.execution_mode,
  });
  if (!card?.value_digest) return failure(d, "vault_item_not_found");
  if (
    await priorUseBlocks(ctx.db, {
      tenant_id: ctx.tenant_id,
      item_id: card.item_id,
      purpose: "pay",
      origin: page.origin,
      conversation_id: null,
      run_id: ctx.execution_id,
    })
  )
    return failure(d, "already_used");
  const page_fingerprint = sha256HexOfText(payPageFingerprintText(page.origin, page.facts));
  const field_frames = Object.fromEntries(
    Object.keys(page.refs).map((field) => [field, page.origin]),
  );
  const command_id = nextCommandId(session);
  const now = new Date(d.clock.now());
  const payment = await requestVaultPayment(
    ctx.db,
    {
      tenant_id: ctx.tenant_id,
      owner_user_id: session.device_owner,
      card_item_id: card.item_id,
      card_value_digest: card.value_digest,
      card_brand: String(card.fields.brand ?? "card"),
      card_last4: String(card.fields.last4 ?? ""),
      origin: page.origin,
      page_fingerprint,
      fields: page.refs,
      field_frames,
      submit_ref: page.refs.submit ?? "",
      amount_minor: Number(args.amount_minor),
      currency: String(args.currency),
      device_id: session.device_id,
      command_id,
      conversation_id: null,
      tool_call_id: null,
      task_run_id: null,
      execution_id: ctx.execution_id,
    },
    now,
  );
  if (!(await awaitApproval(session, payment))) {
    const later = new Date(d.clock.now());
    await expireVaultPayments(ctx.db, ctx.tenant_id, later);
    await rejectPendingPaymentOf(ctx.db, { tenant_id: ctx.tenant_id, command_id }, later);
    return failure(d, "payment_not_approved");
  }
  const consumed = await consumeApprovedPayment(
    ctx.db,
    { tenant_id: ctx.tenant_id, command_id },
    new Date(d.clock.now()),
  );
  if (!consumed.ok) return failure(d, consumed.code);
  return await sendWithTicket(
    session,
    send,
    "browser.pay",
    {
      partition: args.partition,
      boundary: args.boundary,
      origin: page.origin,
      page_fingerprint,
      fields: page.refs,
      field_frames,
      amount_minor: args.amount_minor,
      currency: args.currency,
    },
    consumed,
    PAY_RESULT_NOTE,
  );
}
