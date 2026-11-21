import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { helperEnv } from "../../shared/local/computer-commands.ts";
import { type Envelope, parseEnvelope } from "../../shared/local/computer-envelope.ts";

export const HELPER_MAX_STDOUT = 96 * 1024 * 1024;
export const HELPER_CALL_LIMIT_MS = 30_000;

export interface HelperSpec {
  readonly path: string;
  readonly state_root: string;
}

export interface HelperCall {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export type HelperOutcome =
  | { readonly kind: "envelope"; readonly envelope: Envelope }
  | { readonly kind: "stopped" }
  | { readonly kind: "timeout" }
  | { readonly kind: "broken"; readonly detail: string };

export interface HelperRunner {
  run(call: HelperCall, signal: AbortSignal): Promise<HelperOutcome>;
}

export interface HelperHooks {
  onSpawn?(pid: number, args: readonly string[]): void;
}

export function createHelperRunner(spec: HelperSpec, hooks: HelperHooks = {}): HelperRunner {
  if (!isAbsolute(spec.path) || !isAbsolute(spec.state_root)) {
    throw new Error("The computer helper needs absolute paths.");
  }
  return {
    run(call, signal) {
      if (signal.aborted) return Promise.resolve({ kind: "stopped" });
      return new Promise((resolve) => {
        const child = spawn(spec.path, [...call.args], {
          env: helperEnv(spec.state_root),
          cwd: "/",
          stdio: [call.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let reason: "stopped" | "timeout" | "overflow" | null = null;
        let settled = false;
        const finish = (outcome: HelperOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const kill = (why: "stopped" | "timeout" | "overflow") => {
          reason ??= why;
          child.kill("SIGKILL");
        };
        const onAbort = () => kill("stopped");
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => kill("timeout"), Math.max(0, call.timeoutMs));
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > HELPER_MAX_STDOUT) kill("overflow");
          else chunks.push(chunk);
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          finish({ kind: "broken", detail: error.code ?? "spawn_failed" });
        });
        child.once("close", () => {
          if (reason === "stopped") return finish({ kind: "stopped" });
          if (reason === "timeout") return finish({ kind: "timeout" });
          if (reason === "overflow") return finish({ kind: "broken", detail: "output_too_large" });
          const parsed = parseEnvelope(Buffer.concat(chunks).toString("utf8"));
          finish(
            parsed.ok
              ? { kind: "envelope", envelope: parsed.envelope }
              : { kind: "broken", detail: `envelope_${parsed.reason}` },
          );
        });
        if (child.pid !== undefined) hooks.onSpawn?.(child.pid, call.args);
        if (call.stdin !== undefined && child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.end(call.stdin, "utf8");
        }
      });
    },
  };
}
