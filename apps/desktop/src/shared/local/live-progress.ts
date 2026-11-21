import { createHash } from "node:crypto";
import {
  capabilityOfKind,
  type DeviceCommand,
  DeviceCommandKindSchema,
  type DeviceResult,
  DeviceResultSchema,
} from "@shared/device/protocol.ts";
import { z } from "zod";
import {
  LIVE_CAPABILITIES,
  type LiveCapability,
  type LiveEvent,
  type LiveSource,
} from "./live-view-model.ts";

export const LIVE_SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type LiveProgress =
  | { readonly type: "running"; readonly target: string }
  | { readonly type: "owner_typing" }
  | { readonly type: "owner_idle" }
  | { readonly type: "handover" }
  | { readonly type: "injection" }
  | { readonly type: "screenshot"; readonly png: Uint8Array; readonly sha256: string }
  | { readonly type: "result"; readonly result: DeviceResult };

const target = z.string().max(200);
const id = z.string().min(1).max(200);

export const LiveWireSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("started"),
      session_id: id,
      capability: z.enum(LIVE_CAPABILITIES),
      source: z.enum(["chat", "schedule", "task"]),
      target,
    })
    .strict(),
  z
    .object({ type: z.literal("running"), command_id: id, kind: DeviceCommandKindSchema, target })
    .strict(),
  z.object({ type: z.literal("result"), command_id: id, result: DeviceResultSchema }).strict(),
  z.object({ type: z.literal("handover"), command_id: id }).strict(),
  z.object({ type: z.literal("owner_typing") }).strict(),
  z.object({ type: z.literal("owner_idle") }).strict(),
  z.object({ type: z.literal("injection") }).strict(),
  z
    .object({
      type: z.literal("screenshot"),
      png: z
        .custom<Uint8Array>((value) => value instanceof Uint8Array)
        .refine((bytes) => bytes.length <= LIVE_SCREENSHOT_MAX_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type LiveWire = z.infer<typeof LiveWireSchema>;

export interface LiveSession {
  readonly session_id: string;
  readonly source: LiveSource;
}

export function sessionOf(
  command: Pick<DeviceCommand, "execution_id" | "task_run_id" | "conversation_id" | "step_id">,
): LiveSession {
  if (command.execution_id !== null) {
    return { session_id: command.execution_id, source: "schedule" };
  }
  if (command.task_run_id !== null) return { session_id: command.task_run_id, source: "task" };
  return { session_id: command.conversation_id ?? command.step_id, source: "chat" };
}

export function liveCapabilityOf(kind: DeviceCommand["kind"]): LiveCapability {
  return capabilityOfKind(kind) === "browser" ? "browser" : "computer";
}

export function browserRunning(
  command: Pick<DeviceCommand, "kind" | "args">,
  page: string | null,
): LiveProgress {
  const url = (Object(command.args) as { url?: unknown }).url;
  return { type: "running", target: (typeof url === "string" ? url : (page ?? "")).slice(0, 200) };
}

export function browserScreenshot(result: DeviceResult): LiveProgress | null {
  const output = (result as { output?: unknown }).output;
  const base64 = (Object(output) as { image?: { base64?: unknown } }).image?.base64;
  if (typeof base64 !== "string") return null;
  const png = new Uint8Array(Buffer.from(base64, "base64"));
  return { type: "screenshot", png, sha256: createHash("sha256").update(png).digest("hex") };
}

export function quietResult(result: DeviceResult): DeviceResult {
  return result.status === "done" ? { status: "done", output: null, evidence: {} } : result;
}

export function liveWires(
  current: string | null,
  command: Pick<
    DeviceCommand,
    "command_id" | "kind" | "execution_id" | "task_run_id" | "conversation_id" | "step_id"
  >,
  progress: LiveProgress,
): { session: string | null; wires: LiveWire[] } {
  const { command_id } = command;
  switch (progress.type) {
    case "running": {
      const session = sessionOf(command);
      const running: LiveWire = {
        type: "running",
        command_id,
        kind: command.kind,
        target: progress.target,
      };
      if (session.session_id === current) return { session: current, wires: [running] };
      return {
        session: session.session_id,
        wires: [
          {
            type: "started",
            ...session,
            capability: liveCapabilityOf(command.kind),
            target: progress.target,
          },
          running,
        ],
      };
    }
    case "result":
      return {
        session: current,
        wires: [{ type: "result", command_id, result: quietResult(progress.result) }],
      };
    case "handover":
      return { session: current, wires: [{ type: "handover", command_id }] };
    case "screenshot":
      return {
        session: current,
        wires: [{ type: "screenshot", png: progress.png, sha256: progress.sha256 }],
      };
    default:
      return { session: current, wires: [{ type: progress.type }] };
  }
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function liveEventOf(wire: LiveWire): { event: LiveEvent; screenshot?: Uint8Array } | null {
  if (wire.type !== "screenshot") return { event: wire };
  if (!isPng(wire.png)) return null;
  const digest = createHash("sha256").update(wire.png).digest("hex");
  return digest === wire.sha256 ? { event: { type: "screenshot" }, screenshot: wire.png } : null;
}

const SESSION_END_EVENTS: ReadonlySet<string> = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.aborted",
  "execution.timed_out",
]);

export function endsSession(name: string, data: string, session: string | null): boolean {
  if (session === null) return false;
  try {
    const body = JSON.parse(data) as {
      execution_id?: unknown;
      conversation_id?: unknown;
      task_run_id?: unknown;
    };
    if (SESSION_END_EVENTS.has(name)) return body.execution_id === session;
    if (name !== "device.session_ended") return false;
    return body.conversation_id === session || body.task_run_id === session;
  } catch {
    return false;
  }
}
