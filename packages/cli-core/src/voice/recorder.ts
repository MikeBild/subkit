import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  parseDshowAudioDevices,
  pcmToWav,
  type RecorderCommand,
  type RecorderTool,
  recorderCommand,
} from "./recorder-detect.ts";

export const DICTATION_MAX_MS = 5 * 60 * 1000;

export interface Recording {
  readonly tool: RecorderTool;
  stop(): Promise<Uint8Array>;
  cancel(): void;
  bytes(): number;
}

type RecorderProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export type Spawner = (command: string, args: readonly string[]) => RecorderProcess;

const defaultSpawner: Spawner = (command, args) =>
  spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

function firstWindowsMicrophone(ffmpeg: string | null): string | undefined {
  if (process.platform !== "win32" || !ffmpeg) return undefined;
  const listing = spawnSync(
    ffmpeg,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  return parseDshowAudioDevices(`${listing.stderr ?? ""}`)[0];
}

export function detectRecorder(
  device = process.env.SUBKIT_MICROPHONE || undefined,
): RecorderCommand | null {
  const which = (tool: RecorderTool) => Bun.which(tool);
  return recorderCommand({
    platform: process.platform,
    which,
    device: device ?? firstWindowsMicrophone(which("ffmpeg")),
  });
}

export function startRecording(
  recorder: RecorderCommand,
  {
    spawner = defaultSpawner,
    maxMs = DICTATION_MAX_MS,
    onLimit,
  }: { spawner?: Spawner; maxMs?: number; onLimit?: () => void } = {},
): Recording {
  const child = spawner(recorder.command, recorder.args);
  const chunks: Uint8Array[] = [];
  let received = 0;
  let errorText = "";
  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(new Uint8Array(chunk));
    received += chunk.byteLength;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorText = `${errorText}${chunk.toString("utf8")}`.slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });
  const limit = setTimeout(() => onLimit?.(), maxMs);

  const halt = () => {
    clearTimeout(limit);
    if (child.exitCode !== null) return;
    if (recorder.stop === "stdin-q" && child.stdin.writable) child.stdin.end("q");
    else child.kill("SIGINT");
  };

  return {
    tool: recorder.tool,
    bytes: () => received,
    async stop() {
      halt();
      let grace: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => {
          grace = setTimeout(() => resolve("timeout"), 3_000);
        }),
      ]);
      clearTimeout(grace);
      if (code === "timeout") child.kill("SIGKILL");
      if (received === 0) throw new Error(errorText.trim() || `${recorder.tool} recorded no audio`);
      const pcm = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return pcmToWav(pcm);
    },
    cancel() {
      clearTimeout(limit);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
