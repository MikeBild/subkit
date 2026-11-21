import { SiteAllowanceSchema } from "@shared/device/boundary.ts";
import {
  DeviceCapabilitySchema,
  DeviceOsSchema,
  DeviceStopReportSchema,
} from "@shared/device/protocol.ts";
import { z } from "zod";
import { COMPUTER_OFF, ComputerSnapshotSchema } from "./computer-allowances.ts";
import { FilesSnapshotSchema } from "./files-allowances.ts";
import { LiveWireSchema } from "./live-progress.ts";

export const RUNNER_SERVICE_NAME = "SubKit Runner";
export const RUNNER_ENV_ALLOWLIST = ["PATH", "TMPDIR", "LANG"] as const;

export const RunnerBrowserConfigSchema = z
  .object({
    cli_path: z.string().min(1).max(4096),
    version: z.string().min(1).max(64),
    data_dir: z.string().min(1).max(4096),
    sites: z.array(SiteAllowanceSchema).max(1000),
  })
  .strict();
export type RunnerBrowserConfig = z.infer<typeof RunnerBrowserConfigSchema>;

export const RunnerConfigSchema = z
  .object({
    server_origin: z.url(),
    device_runner_id: z.string().min(1),
    ledger_path: z.string().min(1),
    runner_version: z.string().min(1),
    locale: z.enum(["de", "en"]),
    os: DeviceOsSchema,
    capabilities: z.array(DeviceCapabilitySchema),
    generation: z.number().int().nonnegative(),
    unreported_stop: DeviceStopReportSchema.nullable(),
    files: FilesSnapshotSchema,
    browser: RunnerBrowserConfigSchema.nullable().optional(),
    computer: ComputerSnapshotSchema.default(COMPUTER_OFF),
  })
  .strict();
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

export const MainToRunnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), config: RunnerConfigSchema }).strict(),
  z.object({ type: z.literal("stop"), report: DeviceStopReportSchema }).strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
  z
    .object({
      type: z.literal("signed"),
      request_id: z.string().min(1),
      signature: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("trashed"),
      request_id: z.string().min(1),
      ok: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("marked"),
      request_id: z.string().min(1),
      ok: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("allowances"), files: FilesSnapshotSchema }).strict(),
  z
    .object({
      type: z.literal("volume_id"),
      request_id: z.string().min(1),
      volume_id: z.string().min(1).max(200).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("computer"), computer: ComputerSnapshotSchema }).strict(),
  z.object({ type: z.literal("hand_back"), command_id: z.string().min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("idle"),
      request_id: z.string().min(1),
      seconds: z.number().nonnegative().nullable(),
    })
    .strict(),
]);
export type MainToRunner = z.infer<typeof MainToRunnerSchema>;

export const RUNNER_STATES = ["starting", "connected", "offline", "revoked", "stopped"] as const;

export const RunnerToMainSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("state"), state: z.enum(RUNNER_STATES) }).strict(),
  z
    .object({
      type: z.literal("stop_reported"),
      generation: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sign_assertion"),
      request_id: z.string().min(1),
      assertion: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("trash"),
      request_id: z.string().min(1),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("mark"),
      request_id: z.string().min(1),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("volume"),
      request_id: z.string().min(1),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ type: z.literal("idle_query"), request_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("live"), event: LiveWireSchema }).strict(),
]);
export type RunnerToMain = z.infer<typeof RunnerToMainSchema>;
export type RunnerState = (typeof RUNNER_STATES)[number];

export const STOP_GRACE_MS = 500;

export const StopStateSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    stopped_at: z.iso.datetime({ offset: true }).nullable(),
    reported: z.boolean(),
  })
  .strict();
export type StopState = z.infer<typeof StopStateSchema>;

export const INITIAL_STOP_STATE: StopState = { generation: 0, stopped_at: null, reported: true };

export function parseStopState(raw: unknown): StopState {
  const parsed = StopStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : INITIAL_STOP_STATE;
}

export function markStopped(state: StopState, now: number): StopState {
  return {
    generation: state.generation + 1,
    stopped_at: new Date(now).toISOString(),
    reported: false,
  };
}

export function markReported(state: StopState, generation: number): StopState {
  return generation >= state.generation ? { ...state, reported: true } : state;
}

export function unreportedStop(
  state: StopState,
): { generation: number; stopped_at: string } | null {
  return state.reported || !state.stopped_at
    ? null
    : { generation: state.generation, stopped_at: state.stopped_at };
}
