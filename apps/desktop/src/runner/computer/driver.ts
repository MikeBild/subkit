import { createHash } from "node:crypto";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  ComputerAppsArgsSchema,
  type ComputerAudit,
  ComputerKeyArgsSchema,
  ComputerRefArgsSchema,
  ComputerScrollArgsSchema,
  ComputerSelectArgsSchema,
  ComputerSetValueArgsSchema,
  ComputerTypeArgsSchema,
  ComputerWindowArgsSchema,
} from "@shared/device/computer.ts";
import type { DeviceCommand, DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";
import { classifyApp } from "@shared/local-policy/blocked-apps.ts";
import { screenshotSize, secureFocus } from "@shared/local-policy/redaction-rects.ts";
import {
  appAccess,
  type ComputerApp,
  type ComputerSnapshot,
  computerClosed,
  frontmostVerdict,
  isActing,
  modeOf,
  targetVerdict,
} from "../../shared/local/computer-allowances.ts";
import {
  clickArgs,
  comboFor,
  focusArgs,
  pointerClickArgs,
  pressArgs,
  screenshotArgs,
  scrollArgs,
  selectArgs,
  setValueArgs,
  typeArgs,
} from "../../shared/local/computer-commands.ts";
import {
  frontmostWindow,
  type InventoryWindow,
  screenshotData,
  touchedSecureField,
} from "../../shared/local/computer-envelope.ts";
import { redactionPlan } from "../../shared/local/computer-redaction.ts";
import {
  findRef,
  fullyObserved,
  labelHash,
  modelTree,
  nodeAt,
  type RefInfo,
  toAxNode,
} from "../../shared/local/computer-tree.ts";
import {
  FILE_DIALOG_DETAIL,
  FILE_DIALOG_REMEDY,
  fileDialogIn,
} from "../../shared/local/file-dialog.ts";
import type { LiveProgress } from "../../shared/local/live-progress.ts";
import { type IdlePolicy, idleStep, OWNER_IDLE } from "../../shared/local/owner-idle.ts";
import type { DeviceAdapter } from "../adapter.ts";
import { createHelperRunner, type HelperRunner } from "./helper.ts";
import { blackOut, decodePng, downscale, encodePng } from "./png.ts";
import { failed, refused, refusedWith } from "./results.ts";
import {
  type CallContext,
  call,
  data,
  fail,
  inventory,
  type KnownSnapshot,
  SnapshotMemory,
  type Step,
  snapshot,
  verdictOf,
} from "./session.ts";

export const COMPUTER_KINDS: readonly DeviceCommandKind[] = [
  "computer.apps",
  "computer.snapshot",
  "computer.screenshot",
  "computer.press",
  "computer.focus",
  "computer.select",
  "computer.set_value",
  "computer.type",
  "computer.key",
  "computer.scroll",
];

export interface ComputerDeps {
  readonly device_id: string;
  snapshot(): ComputerSnapshot;
  idleSeconds(signal: AbortSignal): Promise<number | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  progress(command: DeviceCommand, progress: LiveProgress): void;
  helperFor?(spec: { path: string; state_root: string }): HelperRunner;
  idlePolicy?: IdlePolicy;
}

interface Context extends CallContext {
  readonly deps: ComputerDeps;
  readonly command: DeviceCommand;
  readonly computer: ComputerSnapshot;
  readonly memory: SnapshotMemory;
}

interface Target {
  readonly window: InventoryWindow;
  readonly app: ComputerApp;
  readonly windows: readonly InventoryWindow[];
}

const BAD_ARGS = failed("bad_args", "The command arguments are not valid for this device.");

function parse<T>(
  schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
  raw: unknown,
): T | null {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function report(context: Context, progress: LiveProgress): void {
  context.deps.progress(context.command, progress);
}

async function ownerIdle(context: Context): Promise<Step<number>> {
  const policy = context.deps.idlePolicy ?? OWNER_IDLE;
  let waited = 0;
  for (;;) {
    if (context.signal.aborted) return fail({ status: "stopped" });
    const step = idleStep(await context.deps.idleSeconds(context.signal), waited, policy);
    if (step.kind === "act") {
      if (waited > 0) report(context, { type: "owner_idle" });
      return { ok: true, value: waited };
    }
    if (step.kind === "owner_active") return fail(refused("owner_active"));
    if (waited === 0) report(context, { type: "owner_typing" });
    await context.deps.sleep(step.wait_ms, context.signal);
    waited += step.wait_ms;
  }
}

async function checked(
  context: Context,
  windowId: string | null,
  boundary: DeviceSubBoundary | undefined,
): Promise<Step<Target>> {
  const listed = await inventory(context);
  if (!listed.ok) return listed;
  const windows = listed.value;
  const window = windows.find((entry) => entry.id === windowId);
  if (!window) return fail(refused("stale"));
  const verdict = targetVerdict({
    kind: context.command.kind,
    mode: modeOf(context.command),
    device_id: context.deps.device_id,
    snapshot: context.computer,
    boundary,
    target: window.app,
  });
  if (!verdict.ok) return fail(refused(verdict.code));
  return { ok: true, value: { window, app: verdict.app, windows } };
}

async function target(
  context: Context,
  windowId: string | null,
  boundary: DeviceSubBoundary | undefined,
): Promise<Step<Target>> {
  let found = await checked(context, windowId, boundary);
  if (!found.ok) return found;
  report(context, { type: "running", target: found.value.app.display });
  if (!isActing(context.command.kind)) return found;
  const idle = await ownerIdle(context);
  if (!idle.ok) return idle;
  if (idle.value > 0) {
    found = await checked(context, windowId, boundary);
    if (!found.ok) return found;
  }
  const front = frontmostVerdict(
    context.computer,
    frontmostWindow(found.value.windows)?.app ?? null,
  );
  return front.ok ? found : fail(refused(front.code));
}

function audit(
  app: ComputerApp,
  kind: DeviceCommandKind,
  ref: RefInfo | null,
  deviceId: string,
): ComputerAudit {
  return {
    app_bundle_id: app.bundle_id,
    action: kind,
    ax_role: ref?.role ?? null,
    label_hash: ref ? labelHash(deviceId, app.bundle_id, ref.role, ref.label) : null,
  };
}

async function listApps(context: Context): Promise<DeviceResult> {
  if (!parse(ComputerAppsArgsSchema, context.command.args)) return BAD_ARGS;
  if (!context.computer.enabled) return refused("outside_allowance");
  if (!context.computer.permissions.accessibility) return refused("permission_missing");
  const listed = await inventory(context);
  if (!listed.ok) return listed.result;
  const windows = listed.value.flatMap((window) => {
    const verdict = appAccess(context.computer, window.app);
    if (!verdict.ok) return [];
    return [
      {
        window_id: window.id,
        bundle_id: verdict.app.bundle_id,
        app: verdict.app.display,
        title: window.title,
        focused: window.focused,
        view_only: classifyApp(window.app.bundle_id, window.app.name, "darwin").access !== "full",
      },
    ];
  });
  return { status: "done", output: { windows }, evidence: {} };
}

async function readWindow(context: Context): Promise<DeviceResult> {
  const args = parse(ComputerWindowArgsSchema, context.command.args);
  if (!args) return BAD_ARGS;
  const found = await target(context, args.window_id, args.boundary);
  if (!found.ok) return found.result;
  const read = await snapshot(context, found.value.window.id, found.value.app.bundle_id);
  if (!read.ok) return read.result;
  if (fileDialogIn(read.value.tree)) return refusedWith("blocked_app", FILE_DIALOG_DETAIL);
  context.memory.remember(read.value);
  return {
    status: "done",
    output: {
      snapshot_id: read.value.snapshot_id,
      window: { id: found.value.window.id, title: found.value.window.title },
      app: found.value.app.display,
      state_hash: read.value.hash,
      complete: read.value.complete,
      tree: modelTree(read.value.tree),
      audit: audit(found.value.app, context.command.kind, null, context.deps.device_id),
    },
    evidence: { after_version: read.value.hash },
  };
}

async function screenshot(context: Context): Promise<DeviceResult> {
  const args = parse(ComputerWindowArgsSchema, context.command.args);
  if (!args) return BAD_ARGS;
  const found = await target(context, args.window_id, args.boundary);
  if (!found.ok) return found.result;
  const { window, app } = found.value;
  if (!window.bounds) return refused("stale");
  const before = await snapshot(context, window.id, app.bundle_id);
  if (!before.ok) return before.result;
  if (fileDialogIn(before.value.tree)) return refusedWith("blocked_app", FILE_DIALOG_DETAIL);
  if (!before.value.complete || !fullyObserved(before.value.tree)) {
    return failed("window_too_large", "The window has more controls than SubKit can check.");
  }
  if (secureFocus(toAxNode(before.value.tree))) return refused("secure_focus");
  const shot = await data(context, screenshotArgs(window.id));
  if (!shot.ok) return shot.result;
  const image = screenshotData(shot.value);
  const decoded = image ? decodePng(Buffer.from(image.data, "base64")) : null;
  if (!image || !decoded)
    return failed("screenshot_unreadable", "The screenshot could not be read.");
  const plan = redactionPlan({
    tree: before.value.tree,
    window: window.bounds,
    image: decoded,
    scale: image.scale_factor,
  });
  if (!plan.ok) return refused(plan.code);
  const after = await snapshot(context, window.id, app.bundle_id);
  if (!after.ok) return after.result;
  if (secureFocus(toAxNode(after.value.tree))) return refused("secure_focus");
  if (after.value.hash !== before.value.hash) return refused("stale");
  const size = screenshotSize(decoded.width, decoded.height);
  const png = encodePng(downscale(blackOut(decoded, plan.rects), size.width, size.height));
  const digest = createHash("sha256").update(png).digest("hex");
  report(context, { type: "screenshot", png: new Uint8Array(png), sha256: digest });
  return {
    status: "done",
    output: {
      format: "png",
      width: size.width,
      height: size.height,
      data: png.toString("base64"),
      sha256: digest,
      redacted: plan.rects.length,
      audit: audit(app, context.command.kind, null, context.deps.device_id),
    },
    evidence: { screenshot_ref: `sha256:${digest}`, after_version: after.value.hash },
  };
}

interface Prepared {
  readonly target: Target;
  readonly known: KnownSnapshot;
  readonly fresh: KnownSnapshot;
  readonly ref: RefInfo;
}

async function prepare(
  context: Context,
  args: {
    window_id: string;
    ref: string;
    state_hash?: string | undefined;
    boundary?: DeviceSubBoundary | undefined;
  },
): Promise<Step<Prepared>> {
  const known = context.memory.forRef(args.ref);
  if (!known || known.window_id !== args.window_id) return fail(refused("stale"));
  const ref = findRef(known.tree, args.ref);
  if (!ref) return fail(refused("stale"));
  if (ref.secure) return fail(refused("credential_field"));
  const found = await target(context, args.window_id, args.boundary);
  if (!found.ok) return found;
  if (found.value.app.bundle_id !== known.bundle_id) return fail(refused("stale"));
  const fresh = await snapshot(context, args.window_id, known.bundle_id);
  if (!fresh.ok) return fresh;
  if (fileDialogIn(fresh.value.tree)) return fail(refusedWith("blocked_app", FILE_DIALOG_DETAIL));
  if (fresh.value.hash !== (args.state_hash ?? known.hash)) return fail(refused("stale"));
  return { ok: true, value: { target: found.value, known, fresh: fresh.value, ref } };
}

const TYPING: ReadonlySet<DeviceCommandKind> = new Set([
  "computer.type",
  "computer.set_value",
  "computer.key",
]);

function done(
  context: Context,
  app: ComputerApp,
  ref: RefInfo | null,
  before: string,
  envelopeData: unknown,
): DeviceResult {
  if (touchedSecureField(envelopeData)) {
    return failed("secure_field_touched", "The input reached a password field. SubKit stops here.");
  }
  const delivery = (envelopeData as { disposition?: { delivery?: unknown } } | null)?.disposition
    ?.delivery;
  return {
    status: "done",
    output: {
      delivery: typeof delivery === "string" ? delivery : "delivered_unverified",
      audit: audit(app, context.command.kind, ref, context.deps.device_id),
    },
    evidence: { before_version: before },
  };
}

async function afterAction(
  context: Context,
  prepared: { target: Target; fresh: KnownSnapshot },
): Promise<DeviceResult | null> {
  const post = await snapshot(context, prepared.target.window.id, prepared.target.app.bundle_id);
  if (!post.ok) return null;
  context.memory.remember(post.value);
  if (fileDialogIn(post.value.tree)) {
    return failed(
      "file_dialog_opened",
      `A file dialog opened. ${FILE_DIALOG_REMEDY} SubKit stops here.`,
    );
  }
  if (TYPING.has(context.command.kind) && secureFocus(toAxNode(post.value.tree))) {
    return failed("secure_focus_after_input", "A password field has focus now. SubKit stops here.");
  }
  return null;
}

function actionFor(context: Context): { args: string[]; stdin?: string } | null {
  const raw = context.command.args;
  switch (context.command.kind) {
    case "computer.press": {
      const args = parse(ComputerRefArgsSchema, raw);
      return args ? { args: clickArgs(args.ref) } : null;
    }
    case "computer.focus": {
      const args = parse(ComputerRefArgsSchema, raw);
      return args ? { args: focusArgs(args.ref) } : null;
    }
    case "computer.select": {
      const args = parse(ComputerSelectArgsSchema, raw);
      return args ? { args: selectArgs(args.ref, args.option) } : null;
    }
    case "computer.set_value": {
      const args = parse(ComputerSetValueArgsSchema, raw);
      return args ? { args: setValueArgs(args.ref), stdin: args.value } : null;
    }
    case "computer.type": {
      const args = parse(ComputerTypeArgsSchema, raw);
      return args ? { args: typeArgs(args.ref), stdin: args.text } : null;
    }
    case "computer.scroll": {
      const args = parse(ComputerScrollArgsSchema, raw);
      return args ? { args: scrollArgs(args.ref, args.direction, args.amount) } : null;
    }
    default:
      return null;
  }
}

async function pointerFallback(context: Context, prepared: Prepared): Promise<DeviceResult> {
  const node = nodeAt(prepared.fresh.tree, prepared.ref.path);
  const bounds = node?.bounds;
  const window = prepared.target.window;
  const front = frontmostWindow(prepared.target.windows);
  if (!bounds || !window.bounds || front?.id !== window.id) {
    return failed("no_pointer_fallback", "The control cannot be pressed. Nothing was sent.");
  }
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const inside =
    x > window.bounds.x &&
    y > window.bounds.y &&
    x < window.bounds.x + window.bounds.width &&
    y < window.bounds.y + window.bounds.height;
  if (!inside)
    return failed("no_pointer_fallback", "The control is outside the window. Nothing was sent.");
  const clicked = await call(context, pointerClickArgs(x, y));
  if (!clicked.ok) return clicked.result;
  if (!clicked.value.ok) return verdictOf(clicked.value);
  return done(context, prepared.target.app, prepared.ref, prepared.fresh.hash, clicked.value.data);
}

async function refAction(context: Context): Promise<DeviceResult> {
  const args = parse(ComputerRefArgsSchema.loose(), context.command.args);
  const action = actionFor(context);
  if (!args || !action) return BAD_ARGS;
  const prepared = await prepare(context, args);
  if (!prepared.ok) return prepared.result;
  if (TYPING.has(context.command.kind) && secureFocus(toAxNode(prepared.value.fresh.tree))) {
    return refused("secure_focus");
  }
  context.memory.remember(prepared.value.fresh);
  const ran = await call(context, action.args, action.stdin);
  if (!ran.ok) return ran.result;
  const envelope = ran.value;
  if (!envelope.ok) {
    const unsupported =
      context.command.kind === "computer.press" &&
      envelope.error?.code === "ACTION_NOT_SUPPORTED" &&
      envelope.error.disposition?.delivery === "not_delivered";
    if (!unsupported) return verdictOf(envelope);
  }
  const result = envelope.ok
    ? done(
        context,
        prepared.value.target.app,
        prepared.value.ref,
        prepared.value.fresh.hash,
        envelope.data,
      )
    : await pointerFallback(context, prepared.value);
  if (result.status !== "done") return result;
  return (await afterAction(context, prepared.value)) ?? result;
}

async function keyAction(context: Context): Promise<DeviceResult> {
  const args = parse(ComputerKeyArgsSchema, context.command.args);
  if (!args) return BAD_ARGS;
  const combo = comboFor(args.keys);
  if (!combo.ok) return combo.code === "blocked_shortcut" ? refused("blocked_shortcut") : BAD_ARGS;
  const found = await target(context, args.window_id, args.boundary);
  if (!found.ok) return found.result;
  const fresh = await snapshot(context, args.window_id, found.value.app.bundle_id);
  if (!fresh.ok) return fresh.result;
  if (fileDialogIn(fresh.value.tree)) return refusedWith("blocked_app", FILE_DIALOG_DETAIL);
  if (args.state_hash !== undefined && fresh.value.hash !== args.state_hash)
    return refused("stale");
  if (secureFocus(toAxNode(fresh.value.tree))) return refused("secure_focus");
  const ran = await call(context, pressArgs(combo.combo, args.window_id));
  if (!ran.ok) return ran.result;
  if (!ran.value.ok) return verdictOf(ran.value);
  const result = done(context, found.value.app, null, fresh.value.hash, ran.value.data);
  if (result.status !== "done") return result;
  return (await afterAction(context, { target: found.value, fresh: fresh.value })) ?? result;
}

function dispatch(context: Context): Promise<DeviceResult> {
  switch (context.command.kind) {
    case "computer.apps":
      return listApps(context);
    case "computer.snapshot":
      return readWindow(context);
    case "computer.screenshot":
      return screenshot(context);
    case "computer.key":
      return keyAction(context);
    default:
      return refAction(context);
  }
}

export function createComputerAdapter(deps: ComputerDeps, version: string): DeviceAdapter {
  const memory = new SnapshotMemory();
  const helperFor = deps.helperFor ?? ((spec) => createHelperRunner(spec));
  return {
    name: "computer",
    version,
    kinds: COMPUTER_KINDS,
    async execute(command, signal) {
      if (signal.aborted) return { status: "stopped" };
      const computer = deps.snapshot();
      if (computerClosed(computer, command) || computer.helper === null)
        return refused("outside_allowance");
      const context: Context = {
        deps,
        command,
        computer,
        memory,
        helper: helperFor(computer.helper),
        signal,
        deadline: Date.parse(command.deadline_at),
        now: deps.now,
      };
      const dispatched = await dispatch(context);
      const result: DeviceResult =
        signal.aborted && dispatched.status !== "done" ? { status: "stopped" } : dispatched;
      deps.progress(command, { type: "result", result });
      return result;
    },
  };
}
