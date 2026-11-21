import {
  browserSnapshotElements,
  computerTreeElements,
  type ElementEntry,
  pickElement,
} from "@shared/device/element-target.ts";
import {
  capabilityOfKind,
  type DeviceCommandKind,
  DeviceCommandKindSchema,
  type DeviceEvidence,
} from "@shared/device/protocol.ts";
import { z } from "zod";
import { dispatchedOutcome, parseCommandArgs } from "../../../../devices/core/command-args.ts";
import { workflowCommandId } from "../../../../devices/core/command-id.ts";
import { commandEffect } from "../../../../devices/core/offline-policy.ts";
import type { LocalRunSource } from "../../../../devices/core/run-source.ts";
import {
  approvedBoundary,
  argsWithRef,
  argsWithWindow,
  type LocalStepKind,
  localStepArgs,
  parseLocalStep,
  type StepArgsPlan,
  windowFor,
} from "../../../../devices/core/step-args.ts";
import { deviceStepError, deviceStepOutput } from "../../../../devices/core/step-output.ts";
import {
  executionAuthorityPin,
  executionRunSource,
  sendDeviceCommand,
} from "../../../../devices/dispatch.ts";
import { findTenantFile } from "../../../../files/service/index.ts";
import { LOCAL_DRIVER_CAPABILITY } from "../../../../workflows/core/effect-manifest.ts";
import type { StepErrorDetail, StepResult } from "../../../types.ts";
import { linkWorkflowOutputFile } from "../file-output.ts";
import { heldStepResult } from "../side-effects.ts";
import {
  elapsed,
  failedStep,
  type RequestDispatch,
  type RequestStepDriver,
  requireConnector,
} from "./context.ts";

type LocalDriverKind = keyof typeof LOCAL_DRIVER_CAPABILITY;

const DeviceConfigSchema = z.object({ device_id: z.string().uuid() }).passthrough();

export function localCommandOf(driver: LocalDriverKind, path: string | null) {
  const parsed = DeviceCommandKindSchema.safeParse((path ?? "").replace(/^\/+/, ""));
  if (!parsed.success) return null;
  return capabilityOfKind(parsed.data) === LOCAL_DRIVER_CAPABILITY[driver] ? parsed.data : null;
}

type Sent =
  | { ok: true; output: unknown; evidence: DeviceEvidence }
  | { ok: false; step: StepResult };

interface Session {
  d: RequestDispatch;
  device_id: string;
  source: LocalRunSource | null;
  pin: { authority_id: string; manifest_digest: string } | null;
  next: number;
}

function failure(
  d: RequestDispatch,
  error: StepErrorDetail,
  status: StepResult["status"] = "failed",
): StepResult {
  return { status, error, retry_count: 0, duration_ms: elapsed(d) };
}

async function send(
  session: Session,
  kind: DeviceCommandKind,
  args: Record<string, unknown>,
): Promise<Sent> {
  const { d } = session;
  const ctx = d.p.ctx;
  d.record_effect(commandEffect(kind));
  const effect_index = session.next;
  session.next += 1;
  const outcome = await sendDeviceCommand(
    { db: ctx.db, signal: d.signal, now: () => d.clock.now() },
    {
      command_id: workflowCommandId({
        execution_id: ctx.execution_id,
        step_id: d.p.step.id,
        call_path: [],
        iteration_path: ctx.evaluation_seed ?? ctx.execution_id,
        effect_index,
      }),
      tenant_id: ctx.tenant_id,
      device_id: session.device_id,
      execution_id: ctx.execution_id,
      task_run_id: null,
      step_id: d.p.step.id,
      authority_id: session.pin?.authority_id ?? null,
      manifest_digest: session.pin?.manifest_digest ?? null,
      kind,
      args,
      source: session.source,
    },
  );
  if (outcome.kind === "result") {
    const result = outcome.result;
    if (result.status === "done")
      return { ok: true, output: result.output, evidence: result.evidence };
    if (result.status === "refused" || result.status === "failed")
      return { ok: false, step: failure(d, deviceStepError(result.code, result.detail)) };
  }
  const other = dispatchedOutcome(outcome);
  return {
    ok: false,
    step: failure(
      d,
      { code: other.code ?? "device_failed", message: other.message ?? "" },
      other.status === "succeeded" ? "failed" : other.status,
    ),
  };
}

const WINDOW_KINDS: ReadonlySet<string> = new Set([
  "computer.snapshot",
  "computer.screenshot",
  "computer.key",
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.scroll",
]);

async function finalArgs(
  session: Session,
  plan: StepArgsPlan,
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; step: StepResult }> {
  const { d } = session;
  const boundary = plan.args.boundary;
  let window_id: string | undefined;
  if (WINDOW_KINDS.has(plan.kind) && plan.app_id !== null) {
    const apps = await send(session, "computer.apps", { boundary });
    if (!apps.ok) return apps;
    const found = windowFor(apps.output, plan.app_id);
    if (found === null) return { ok: false, step: failure(d, deviceStepError("app_not_open")) };
    window_id = found;
  }
  if (plan.element === null)
    return {
      ok: true,
      args: window_id === undefined ? plan.args : argsWithWindow(plan, window_id),
    };
  let entries: ElementEntry[];
  let state_hash: string | undefined;
  if (window_id === undefined) {
    const snap = await send(session, "browser.snapshot", {
      partition: plan.args.partition,
      boundary,
    });
    if (!snap.ok) return snap;
    entries = browserSnapshotElements(snap.output);
  } else {
    const snap = await send(session, "computer.snapshot", { window_id, boundary });
    if (!snap.ok) return snap;
    const output = (snap.output ?? {}) as { tree?: unknown; state_hash?: unknown };
    entries = computerTreeElements(output.tree);
    if (typeof output.state_hash === "string") state_hash = output.state_hash;
  }
  const pick = pickElement(entries, plan.element);
  if (!pick.ok)
    return {
      ok: false,
      step: failure(d, deviceStepError(pick.code, undefined, { matches: pick.matches })),
    };
  return {
    ok: true,
    args: argsWithRef(plan, {
      ref: pick.ref,
      ...(window_id === undefined ? {} : { window_id }),
      ...(state_hash === undefined ? {} : { state_hash }),
    }),
  };
}

async function stepOutput(
  session: Session,
  kind: LocalStepKind,
  sent: { output: unknown; evidence: DeviceEvidence },
): Promise<StepResult> {
  const { d } = session;
  const ctx = d.p.ctx;
  const mapped = deviceStepOutput(kind, sent.output, sent.evidence);
  const succeeded = (output: unknown): StepResult => ({
    status: "succeeded",
    output,
    retry_count: 0,
    duration_ms: elapsed(d),
  });
  switch (mapped.kind) {
    case "error":
      return failure(d, mapped.error);
    case "output":
      return succeeded(mapped.output);
    case "import": {
      const file = await findTenantFile(ctx.db, ctx.tenant_id, mapped.file_id);
      if (!file) return failure(d, deviceStepError("import_unverified"));
      const envelope = await linkWorkflowOutputFile({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        execution_id: ctx.execution_id,
        file,
      });
      return succeeded({
        ...envelope,
        file_id: file.id,
        sha256: mapped.sha256 ?? file.sha256 ?? null,
      });
    }
  }
}

async function executeLocal(driver: LocalDriverKind, d: RequestDispatch): Promise<StepResult> {
  const connector = requireConnector(d);
  const config = DeviceConfigSchema.safeParse(connector.config);
  if (!config.success)
    return failedStep(d, {
      code: "device_not_configured",
      message: "This connector names no device. Nothing ran.",
    });
  const kind = localCommandOf(driver, d.parts.path);
  if (!kind)
    return failedStep(d, {
      code: "local_command_unknown",
      message: "This step names no action this device can run. Nothing ran.",
    });
  const ctx = d.p.ctx;
  const device_id = config.data.device_id;
  const step = { kind, method: d.p.step.method, body: d.parts.body, partition: connector.id };
  if (d.state.holdThisStep) {
    const parsed = parseLocalStep(step);
    if (!parsed.ok) return failedStep(d, deviceStepError(parsed.code, parsed.detail));
    return heldStepResult({
      start: d.start,
      clock: d.clock,
      method: d.p.step.method,
      url: null,
      body: { kind, args: parsed.plan.args },
    });
  }
  const pin = await executionAuthorityPin(ctx.db, ctx.tenant_id, ctx.execution_id);
  const planned = localStepArgs({
    ...step,
    boundary: pin
      ? approvedBoundary(pin.manifest, d.p.step.id, device_id, LOCAL_DRIVER_CAPABILITY[driver])
      : null,
  });
  if (!planned.ok) return failedStep(d, deviceStepError(planned.code, planned.detail));
  await d.before_dispatch();
  const session: Session = {
    d,
    device_id,
    source: await executionRunSource(ctx.db, ctx.tenant_id, ctx.execution_id, device_id),
    pin: pin ? { authority_id: pin.authority_id, manifest_digest: pin.manifest_digest } : null,
    next: 0,
  };
  const prepared = await finalArgs(session, planned.plan);
  if (!prepared.ok) return prepared.step;
  if (!parseCommandArgs(planned.plan.kind, prepared.args).ok)
    return failedStep(d, deviceStepError("local_step_invalid"));
  const sent = await send(session, planned.plan.kind, prepared.args);
  if (!sent.ok) return sent.step;
  return stepOutput(session, planned.plan.kind, sent);
}

function localDriver<K extends LocalDriverKind>(kind: K): RequestStepDriver & { readonly kind: K } {
  return {
    kind,
    capabilities: {
      retry: "none",
      pagination: "none",
      response_filters: "none",
      circuit_close: "outcome",
      step_timer: false,
      owns_setup_errors: false,
      failure_code: "device_failed",
    },
    retryPolicy: () => null,
    classifySideEffects: (step) => {
      const command = localCommandOf(kind, step.path ?? null);
      return command ? commandEffect(command) : "write";
    },
    execute: (d) => executeLocal(kind, d),
  };
}

export const localFilesRequestDriver = localDriver("local_files");
export const localBrowserRequestDriver = localDriver("local_browser");
export const localComputerRequestDriver = localDriver("local_computer");
