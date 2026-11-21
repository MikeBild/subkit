import { spawn } from "node:child_process";
import { z } from "zod";

export type AgentBrowserResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string; readonly error: string };

export interface AgentBrowserClient {
  call(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentBrowserResult>;
}

export interface AgentBrowserProcessOptions {
  readonly command: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly version: string;
  readonly timeoutMs: number;
}

const MAX_OUTPUT_BYTES = 48 * 1024 * 1024;

const CallOutputSchema = z.object({
  _meta: z.object({ agentBrowserVersion: z.string() }).partial().optional(),
  isError: z.boolean().optional(),
  error: z.object({ message: z.string() }).partial().optional(),
  structuredContent: z
    .object({
      response: z
        .object({
          success: z.boolean().optional(),
          data: z.unknown().optional(),
          error: z.string().nullable().optional(),
          code: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export function parseCallOutput(stdout: string, version: string): AgentBrowserResult {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, code: "browser_unreadable", error: "The browser tool gave no answer." };
  }
  const parsed = CallOutputSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, code: "browser_unreadable", error: "The browser tool gave no answer." };
  const output = parsed.data;
  const reported = output._meta?.agentBrowserVersion;
  if (reported !== version)
    return {
      ok: false,
      code: "browser_version",
      error: `The browser tool reports version ${reported ?? "unknown"}, expected ${version}.`,
    };
  if (output.error)
    return { ok: false, code: "browser_call", error: output.error.message ?? "call refused" };
  const response = output.structuredContent?.response ?? null;
  if (output.isError === true || response === null || response.success !== true)
    return {
      ok: false,
      code: response?.code ?? "browser_action",
      error: response?.error ?? "The browser action failed.",
    };
  return { ok: true, data: response.data ?? null };
}

export function callArguments(tool: string, args: Record<string, unknown>): string[] {
  return ["mcp", "call", tool, JSON.stringify(args), "--tools", "all"];
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export function createAgentBrowserProcess(options: AgentBrowserProcessOptions): AgentBrowserClient {
  const [executable, ...prefix] = options.command;
  if (executable === undefined) throw new Error("agent-browser command is empty");
  return {
    call(tool, args, signal) {
      if (signal.aborted) return Promise.resolve({ ok: false, code: "stopped", error: "Stopped." });
      return new Promise((resolve) => {
        const child = spawn(executable, [...prefix, ...callArguments(tool, args)], {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (result: AgentBrowserResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => {
          killGroup(child.pid);
          finish({ ok: false, code: "stopped", error: "Stopped." });
        };
        const timer = setTimeout(() => {
          killGroup(child.pid);
          finish({
            ok: false,
            code: "browser_timeout",
            error: "The browser did not answer in time.",
          });
        }, options.timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES) {
            killGroup(child.pid);
            finish({ ok: false, code: "too_large", error: "The browser answer is too large." });
            return;
          }
          chunks.push(chunk);
        });
        child.once("error", () =>
          finish({ ok: false, code: "browser_missing", error: "The browser tool did not start." }),
        );
        child.once("close", () =>
          finish(parseCallOutput(Buffer.concat(chunks).toString("utf8"), options.version)),
        );
      });
    },
  };
}
