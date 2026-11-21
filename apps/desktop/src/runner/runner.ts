import { randomUUID } from "node:crypto";
import { backoffDelay } from "@shared/backoff.ts";
import type { DeviceCommand, DeviceResult, Heartbeat } from "@shared/device/protocol.ts";
import { COMPUTER_OFF, type ComputerSnapshot } from "../shared/local/computer-allowances.ts";
import { downloadWriteCommand } from "../shared/local/download-write.ts";
import {
  allowancesDigest,
  EMPTY_FILES_SNAPSHOT,
  type FilesSnapshot,
} from "../shared/local/files-allowances.ts";
import {
  browserRunning,
  browserScreenshot,
  type LiveProgress,
  liveWires,
} from "../shared/local/live-progress.ts";
import { HEARTBEAT_INTERVAL_MS, personalCapabilities } from "../shared/local/runner-channel.ts";
import { replayVerdict } from "../shared/local/runner-ledger.ts";
import {
  type MainToRunner,
  MainToRunnerSchema,
  type RunnerConfig,
  type RunnerState,
  type RunnerToMain,
} from "../shared/local/runner-port.ts";
import { type DeviceAdapter, routeCommands } from "./adapter.ts";
import { type BrowserCapability, createBrowserCapability } from "./browser/index.ts";
import { ChannelError, createHttpChannel, type RunnerChannel } from "./channel.ts";
import { createComputerAdapter } from "./computer/driver.ts";
import { createFilesAdapter } from "./files/driver.ts";
import { cleanLeftovers } from "./files/leftovers.ts";
import { createHandover } from "./handover.ts";
import { createImporter } from "./importer.ts";
import { openLedger, type RunnerLedger } from "./ledger.ts";
import { createRunnerQueue, type RunnerQueue } from "./queue.ts";
import { abortableWait, createStopReporter, type StopReporter } from "./stop-report.ts";

export interface RunnerPort {
  postMessage(message: RunnerToMain): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

export interface RunnerOptions {
  readonly exit?: () => void;
}

export function runRunner(port: RunnerPort, options: RunnerOptions = {}): void {
  const pending = new Map<string, (value: unknown) => void>();

  function ask<T>(message: RunnerToMain & { request_id: string }): Promise<T> {
    return new Promise((resolve) => {
      pending.set(message.request_id, resolve as (value: unknown) => void);
      port.postMessage(message);
    });
  }

  function askUntil(
    message: RunnerToMain & { request_id: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        pending.delete(message.request_id);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void ask<boolean>(message).then((value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value === true);
      });
    });
  }

  function setState(state: RunnerState): void {
    port.postMessage({ type: "state", state });
  }

  let files: FilesSnapshot = EMPTY_FILES_SNAPSHOT;
  const volumes = new Map<number, string>();

  async function volumeId(path: string, dev: number): Promise<string> {
    const known = volumes.get(dev);
    if (known) return known;
    const asked = await Promise.race([
      ask<string | null>({ type: "volume", request_id: randomUUID(), path }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    const id = asked ?? String(dev);
    if (asked) volumes.set(dev, asked);
    return id;
  }

  const trashFromRunner = (path: string) =>
    askUntil({ type: "trash", request_id: randomUUID(), path }, AbortSignal.timeout(30_000));

  let computer: ComputerSnapshot = COMPUTER_OFF;
  let liveSession: string | null = null;

  function idleSeconds(signal: AbortSignal): Promise<number | null> {
    if (signal.aborted) return Promise.resolve(null);
    return Promise.race([
      ask<number | null>({ type: "idle_query", request_id: randomUUID() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  function filesFor(config: RunnerConfig): DeviceAdapter {
    return createFilesAdapter(
      {
        device_id: config.device_runner_id,
        snapshot: () => files,
        trash: (path) => trashFromRunner(path),
        volumeId,
        mark: (path) =>
          askUntil({ type: "mark", request_id: randomUUID(), path }, AbortSignal.timeout(10_000)),
        importer: createImporter({
          create: (body) => channelOf().createUpload(body),
          chunk: (id, n, bytes) => channelOf().putChunk(id, n, bytes),
          commit: (id, body) => channelOf().commitUpload(id, body),
          abort: (id) => channelOf().abortUpload(id),
        }),
        progress: (commandId, note) =>
          void channelOf()
            .progress(commandId, note.slice(0, 500))
            .catch(() => {}),
      },
      config.runner_version,
    );
  }

  function live(command: DeviceCommand, progress: LiveProgress): void {
    const next = liveWires(liveSession, command, progress);
    liveSession = next.session;
    for (const event of next.wires) port.postMessage({ type: "live", event });
  }

  const handover = createHandover("handover", live);

  function executeFor(
    config: RunnerConfig,
    filesAdapter: DeviceAdapter,
    browser: BrowserCapability | null,
  ) {
    return routeCommands([
      filesAdapter,
      handover.adapter,
      createComputerAdapter(
        {
          device_id: config.device_runner_id,
          snapshot: () => computer,
          idleSeconds,
          sleep,
          now: Date.now,
          progress: live,
        },
        config.runner_version,
      ),
      ...(browser ? [browser.adapter] : []),
    ]);
  }

  interface Session {
    execute: (command: DeviceCommand, signal: AbortSignal) => Promise<DeviceResult>;
    commands: Map<string, DeviceCommand>;
    channel: RunnerChannel;
    ledger: RunnerLedger;
    queue: RunnerQueue;
    stops: StopReporter;
    abort: AbortController;
    browser: BrowserCapability | null;
  }

  let session: Session | null = null;

  function channelOf(): RunnerChannel {
    if (!session) throw new Error("The runner has no session.");
    return session.channel;
  }

  function heartbeatBody(config: RunnerConfig, generation: number): Heartbeat {
    return {
      generation,
      runner_version: config.runner_version,
      os: config.os,
      capabilities: config.capabilities,
      personal: personalCapabilities(config.capabilities, files.personal_enabled),
      permissions: computer.permissions,
      allowances_digest: allowancesDigest(config.device_runner_id, files),
    };
  }

  async function report(current: Session, commandId: string, result: DeviceResult): Promise<void> {
    current.ledger.remember(commandId, result, current.commands.get(commandId) ?? null);
    current.commands.delete(commandId);
    await current.channel.result(commandId, result).catch(() => {});
  }

  async function onAvailable(current: Session, commandId: string): Promise<void> {
    const known = current.ledger.recall(commandId);
    if (known) {
      const result = known.replay
        ? replayVerdict(
            known.result,
            await current.execute(known.replay, AbortSignal.timeout(60_000)),
          )
        : known.result;
      await current.channel.result(commandId, result).catch(() => {});
      return;
    }
    const command = await current.channel.claim(commandId);
    if (!command) return;
    current.commands.set(commandId, command);
    current.queue.submit(command);
  }

  async function streamLoop(current: Session): Promise<void> {
    let attempt = 0;
    while (!current.abort.signal.aborted) {
      try {
        setState("connected");
        await current.channel.stream((event) => {
          attempt = 0;
          if (event.type === "command.available") void onAvailable(current, event.command_id);
          else if (event.type === "command.cancelled") current.queue.cancel(event.command_id);
          else {
            setState("revoked");
            current.queue.stop();
            current.abort.abort();
          }
        }, current.abort.signal);
      } catch (error) {
        if (current.abort.signal.aborted) return;
        if (error instanceof ChannelError && error.status === 403) {
          setState("revoked");
          current.abort.abort();
          return;
        }
      }
      if (current.abort.signal.aborted) return;
      setState("offline");
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt++, Math.random())));
    }
  }

  function start(config: RunnerConfig): void {
    if (session) return;
    files = config.files;
    computer = config.computer;
    const abort = new AbortController();
    const channel = createHttpChannel({
      origin: config.server_origin,
      deviceRunnerId: config.device_runner_id,
      sign: (assertion) =>
        ask<string | null>({ type: "sign_assertion", request_id: randomUUID(), assertion }),
      fetch,
      now: Date.now,
      locale: config.locale,
    });
    const ledger = openLedger(config.ledger_path, Date.now);
    const filesAdapter = filesFor(config);
    let page: string | null = null;
    const browser = config.browser
      ? createBrowserCapability({
          config: config.browser,
          onStep: (step) => {
            page = step.origin ?? page;
          },
          sink: {
            write: (input, signal) => filesAdapter.execute(downloadWriteCommand(input), signal),
          },
        })
      : null;
    const execute = executeFor(
      config,
      filesAdapter,
      browser && {
        ...browser,
        adapter: {
          ...browser.adapter,
          async execute(command, signal) {
            live(command, browserRunning(command, page));
            const result = await browser.adapter.execute(command, signal);
            const shot = browserScreenshot(result);
            if (shot) live(command, shot);
            live(command, { type: "result", result });
            return result;
          },
        },
      },
    );
    const current: Session = {
      execute,
      commands: new Map(),
      channel,
      ledger,
      abort,
      browser,
      stops: createStopReporter({
        send: (stopReport) => channel.reportStop(stopReport),
        acknowledged: (generation) => port.postMessage({ type: "stop_reported", generation }),
        wait: abortableWait,
        jitter: Math.random,
      }),
      queue: createRunnerQueue({
        generation: config.generation,
        execute,
        now: Date.now,
        settle: (settled) => void report(current, settled.command_id, settled.result),
      }),
    };
    session = current;
    setState("starting");
    if (config.unreported_stop) current.stops.report(config.unreported_stop);
    const beat = () =>
      void channel.heartbeat(heartbeatBody(config, current.queue.generation())).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    abort.signal.addEventListener("abort", () => {
      clearInterval(timer);
      current.stops.close();
    });
    void streamLoop(current);
    void cleanLeftovers(files, { now: Date.now, trash: trashFromRunner }).catch(() => {});
  }

  function handle(message: MainToRunner): void {
    if (message.type === "start") {
      start(message.config);
      return;
    }
    if (message.type === "stop") {
      liveSession = null;
      handover.stop();
      session?.queue.stop(message.report.generation);
      void session?.browser?.stop();
      session?.stops.report(message.report);
      setState("stopped");
      return;
    }
    if (message.type === "shutdown") {
      session?.queue.stop();
      session?.abort.abort();
      void (session?.browser?.close() ?? Promise.resolve()).finally(
        options.exit ?? (() => process.exit(0)),
      );
      return;
    }
    if (message.type === "allowances") {
      files = message.files;
      volumes.clear();
      return;
    }
    if (message.type === "computer") {
      computer = message.computer;
      return;
    }
    if (message.type === "hand_back") {
      handover.handBack(message.command_id);
      return;
    }
    if (message.type === "idle") pending.get(message.request_id)?.(message.seconds);
    if (message.type === "signed") pending.get(message.request_id)?.(message.signature);
    if (message.type === "trashed" || message.type === "marked")
      pending.get(message.request_id)?.(message.ok);
    if (message.type === "volume_id") pending.get(message.request_id)?.(message.volume_id);
    pending.delete(message.request_id);
  }

  port.on("message", (event) => {
    const parsed = MainToRunnerSchema.safeParse(event.data);
    if (parsed.success) handle(parsed.data);
  });
  port.postMessage({ type: "ready" });
}
