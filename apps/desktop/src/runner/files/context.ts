import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import type { FilesSnapshot } from "../../shared/local/files-allowances.ts";
import { failed, refused } from "../../shared/local/files-policy.ts";
import type { FilesPolicy, ResolveContext, Step, VolumeIdOf } from "./resolve.ts";

export interface ImportSession {
  write(chunk: Uint8Array): Promise<void>;
  commit(sha256: string): Promise<{ file_id: string } | null>;
  abort(): Promise<void>;
}

export interface Importer {
  begin(meta: { command_id: string; name: string; size: number }): Promise<ImportSession | null>;
}

export interface FilesHooks {
  afterPrepare?(path: string): Promise<void>;
  duringRead?(path: string): Promise<void>;
  beforePlace?(path: string): Promise<void>;
}

export interface FilesDeps {
  readonly device_id: string;
  readonly snapshot: () => FilesSnapshot;
  readonly trash: (path: string, signal: AbortSignal) => Promise<boolean>;
  readonly mark: (path: string) => Promise<boolean>;
  readonly importer: Importer | null;
  readonly policy?: FilesPolicy | undefined;
  readonly volumeId?: VolumeIdOf | undefined;
  readonly hooks?: FilesHooks | undefined;
  readonly newId?: (() => string) | undefined;
  readonly progress?: ((commandId: string, note: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export const PROGRESS_EVERY_MS = 10_000;

export interface OpContext {
  readonly deps: FilesDeps;
  readonly resolve: ResolveContext;
  readonly command: DeviceCommand;
  readonly signal: AbortSignal;
  readonly newId: () => string;
  readonly tick: (note: string) => void;
}

export function opContext(
  deps: FilesDeps,
  resolve: ResolveContext,
  command: DeviceCommand,
  signal: AbortSignal,
): OpContext {
  const now = deps.now ?? Date.now;
  let last = now();
  const tick = (note: string) => {
    if (!deps.progress || now() - last < PROGRESS_EVERY_MS) return;
    last = now();
    deps.progress(command.command_id, note);
  };
  return { deps, resolve, command, signal, newId: deps.newId ?? randomUUID, tick };
}

export function resultOf(step: Step<unknown> & { ok: false }): DeviceResult {
  if (step.refusal) return refused(step.refusal);
  return failed(step.failure ?? "io_error");
}

export function itemOf(index: number, step: Step<unknown> & { ok: false }) {
  return step.refusal
    ? { index, status: "refused" as const, code: step.refusal }
    : { index, status: "failed" as const, code: step.failure ?? "io_error" };
}

export async function sendToTrash(context: OpContext, path: string, ino: number): Promise<boolean> {
  const answered = await context.deps.trash(path, context.signal).catch(() => false);
  if (answered) return true;
  const now = await lstat(path).catch(() => null);
  return now === null || now.ino !== ino;
}
