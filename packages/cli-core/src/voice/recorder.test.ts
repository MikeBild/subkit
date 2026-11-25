import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type Spawner, startRecording } from "./recorder.ts";
import type { RecorderCommand } from "./recorder-detect.ts";

class FakeRecorder extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signals: string[] = [];
  stdinText = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString("utf8");
    });
    this.stdin.on("finish", () => this.exit(0));
  }

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.exit(signal === "SIGKILL" ? 137 : 130);
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit("close", code));
  }
}

const ffmpeg: RecorderCommand = { tool: "ffmpeg", command: "ffmpeg", args: [], stop: "stdin-q" };
const rec: RecorderCommand = { tool: "rec", command: "rec", args: [], stop: "kill" };

function fakeSpawner(): { spawner: Spawner; process: () => FakeRecorder } {
  let current: FakeRecorder | null = null;
  return {
    spawner: (() => {
      current = new FakeRecorder();
      return current;
    }) as unknown as Spawner,
    process: () => current as unknown as FakeRecorder,
  };
}

describe("startRecording", () => {
  test("stops ffmpeg with q and returns the captured PCM as WAV", async () => {
    const fake = fakeSpawner();
    const recording = startRecording(ffmpeg, { spawner: fake.spawner, maxMs: 60_000 });
    fake.process().stdout.write(Buffer.from([1, 0, 2, 0]));
    await Promise.resolve();
    expect(recording.bytes()).toBe(4);
    const wav = await recording.stop();
    expect(fake.process().stdinText).toBe("q");
    expect(wav.byteLength).toBe(48);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  test("stops sox-style recorders with SIGINT", async () => {
    const fake = fakeSpawner();
    const recording = startRecording(rec, { spawner: fake.spawner, maxMs: 60_000 });
    fake.process().stdout.write(Buffer.from([9, 9]));
    await Promise.resolve();
    await recording.stop();
    expect(fake.process().signals).toEqual(["SIGINT"]);
  });

  test("reports the recorder's own error when nothing was captured", async () => {
    const fake = fakeSpawner();
    const recording = startRecording(rec, { spawner: fake.spawner, maxMs: 60_000 });
    fake.process().stderr.write("rec FAIL formats: can't open input `default'");
    await Promise.resolve();
    await expect(recording.stop()).rejects.toThrow("can't open input");
  });

  test("cancel kills the recorder", () => {
    const fake = fakeSpawner();
    startRecording(rec, { spawner: fake.spawner, maxMs: 60_000 }).cancel();
    expect(fake.process().signals).toEqual(["SIGKILL"]);
  });
});
