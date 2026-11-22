import { isAbsolute, normalize } from "node:path";
import { shell, type UtilityProcess, utilityProcess } from "electron";
import { type ComputerSnapshot, computerPermissions } from "../shared/local/computer-allowances.ts";
import type { FilesSnapshot } from "../shared/local/files-allowances.ts";
import { liveEventOf } from "../shared/local/live-progress.ts";
import type { LiveEvent } from "../shared/local/live-view-model.ts";
import type { Permissions } from "../shared/local/permission-model.ts";
import { restartPlan } from "../shared/local/restart-policy.ts";
import {
  type MainToRunner,
  markReported,
  markStopped,
  parseStopState,
  RUNNER_ENV_ALLOWLIST,
  RUNNER_SERVICE_NAME,
  type RunnerConfig,
  type RunnerState,
  RunnerToMainSchema,
  STOP_GRACE_MS,
  type StopState,
  unreportedStop,
} from "../shared/local/runner-port.ts";
import type { RunnerProblem } from "../shared/local/runner-problems.ts";
import { signAssertion } from "./runner-key.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export interface RunnerHostOptions {
  script: string;
  config: Omit<RunnerConfig, "generation" | "unreported_stop" | "files" | "computer">;
  computer: () => Omit<ComputerSnapshot, "permissions">;
  permissions: () => Permissions;
  onLive: (event: LiveEvent, screenshot?: Uint8Array) => void;
  onBusy: (commandId: string, busy: boolean) => void;
  onExit: () => void;
  idleSeconds: () => number | null;
  stopStatePath: string;
  files: () => FilesSnapshot;
  mayTouch: (path: string) => boolean;
  mark: (path: string) => Promise<boolean>;
  volumeId: (path: string) => Promise<string | null>;
  privateKey: () => string | null;
  onState: (state: RunnerState | "crashed" | "given_up") => void;
  onProblem: (problem: RunnerProblem) => void;
  now: () => number;
  browser?: { killAll(): Promise<unknown> };
}

export interface RunnerHost {
  start(): void;
  stop(): void;
  computerChanged(): void;
  handBack(commandId: string): void;
  shutdown(): Promise<void>;
  allowancesChanged(): void;
}

function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of RUNNER_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  let child: UtilityProcess | null = null;
  let crashes: readonly number[] = [];
  let wanted = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let stopState: StopState = parseStopState(readJson(options.stopStatePath));
  const saveStopState = (next: StopState) => {
    stopState = next;
    writeJsonAtomic(options.stopStatePath, next);
  };

  const send = (message: MainToRunner) => child?.postMessage(message);
  const guarded = (path: string) =>
    isAbsolute(path) && normalize(path) === path && options.mayTouch(path);
  const computer = (): ComputerSnapshot => ({
    ...options.computer(),
    permissions: computerPermissions(options.permissions()),
  });

  const onMessage = async (raw: unknown) => {
    const parsed = RunnerToMainSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "ready")
      send({
        type: "start",
        config: {
          ...options.config,
          generation: stopState.generation,
          unreported_stop: unreportedStop(stopState),
          files: options.files(),
          computer: computer(),
        },
      });
    else if (message.type === "live") {
      const live = liveEventOf(message.event);
      if (live) options.onLive(live.event, live.screenshot);
    } else if (message.type === "busy") options.onBusy(message.command_id, message.busy);
    else if (message.type === "idle_query") {
      let seconds: number | null = null;
      try {
        seconds = options.idleSeconds();
      } catch {
        seconds = null;
      }
      send({ type: "idle", request_id: message.request_id, seconds });
    } else if (message.type === "problem") options.onProblem(message.problem);
    else if (message.type === "stop_reported")
      saveStopState(markReported(stopState, message.generation));
    else if (message.type === "state") {
      if (message.state === "stopped" && stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      options.onState(message.state);
    } else if (message.type === "sign_assertion") {
      const key = options.privateKey();
      let signature: string | null = null;
      try {
        signature = key ? signAssertion(key, message.assertion) : null;
      } catch {
        signature = null;
      }
      send({ type: "signed", request_id: message.request_id, signature });
    } else if (message.type === "trash") {
      const path = message.path;
      const ok = guarded(path)
        ? await shell.trashItem(path).then(
            () => true,
            () => false,
          )
        : false;
      send({ type: "trashed", request_id: message.request_id, ok });
    } else if (message.type === "volume") {
      const root = options.files().folders.some((folder) => folder.path === message.path);
      const volume_id = root ? await options.volumeId(message.path).catch(() => null) : null;
      send({ type: "volume_id", request_id: message.request_id, volume_id });
    } else if (message.type === "mark") {
      const ok = guarded(message.path)
        ? await options.mark(message.path).catch(() => false)
        : false;
      send({ type: "marked", request_id: message.request_id, ok });
    }
  };

  const spawn = () => {
    const forked = utilityProcess.fork(options.script, [], {
      serviceName: RUNNER_SERVICE_NAME,
      stdio: "ignore",
      env: runnerEnv(),
    });
    child = forked;
    forked.on("message", (raw) => void onMessage(raw));
    forked.once("exit", () => {
      if (child === forked) child = null;
      options.onExit();
      void options.browser?.killAll();
      if (!wanted) return;
      options.onState("crashed");
      const plan = restartPlan(crashes, options.now());
      if (!plan) {
        wanted = false;
        options.onState("given_up");
        return;
      }
      crashes = plan.crashes;
      restartTimer = setTimeout(spawn, plan.delay_ms);
    });
  };

  return {
    allowancesChanged() {
      send({ type: "allowances", files: options.files() });
    },
    start() {
      if (wanted) return;
      wanted = true;
      spawn();
    },
    computerChanged() {
      send({ type: "computer", computer: computer() });
    },
    handBack(commandId) {
      send({ type: "hand_back", command_id: commandId });
    },
    stop() {
      saveStopState(markStopped(stopState, options.now()));
      const report = unreportedStop(stopState);
      const current = child;
      if (!report) return;
      if (!current) return;
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        current.kill();
        void options.browser?.killAll();
      }, STOP_GRACE_MS);
      current.postMessage({ type: "stop", report } satisfies MainToRunner);
    },
    shutdown() {
      wanted = false;
      if (restartTimer) clearTimeout(restartTimer);
      const current = child;
      if (!current) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => current.kill(), STOP_GRACE_MS);
        current.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        current.postMessage({ type: "shutdown" } satisfies MainToRunner);
      });
    },
  };
}
