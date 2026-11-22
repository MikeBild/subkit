import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceCommand } from "@shared/device/protocol.ts";
import { COMPUTER_OFF } from "../shared/local/computer-allowances.ts";
import { EMPTY_FILES_SNAPSHOT } from "../shared/local/files-allowances.ts";
import type { MainToRunner, RunnerConfig, RunnerToMain } from "../shared/local/runner-port.ts";
import type { RunnerProblem } from "../shared/local/runner-problems.ts";
import { command } from "../shared/local/runner-queue.fixture.ts";
import type { ReportPort } from "./report.ts";
import { type RunnerPort, runRunner } from "./runner.ts";

export type Route = (request: { method: string; path: string; body: string | null }) => Response;

export function futureCommand(id: string): DeviceCommand {
  return command(id, { deadline_at: new Date(Date.now() + 60_000).toISOString() });
}

export function claimed(id: string): Response {
  return Response.json(futureCommand(id));
}

export function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "runner-ledger-")), "ledger.json");
}

export interface RunnerRig {
  readonly posted: RunnerToMain[];
  readonly calls: string[];
  readonly problems: RunnerProblem[];
  announce(commandId: string): void;
  dropStream(): void;
  streams(): number;
  shutdown(): Promise<void>;
}

const encoder = new TextEncoder();

export function startRunner(ledger: string, route: Route): RunnerRig {
  const posted: RunnerToMain[] = [];
  const calls: string[] = [];
  const problems: RunnerProblem[] = [];
  let listener: ((event: { data: unknown }) => void) | null = null;
  let open: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamCount = 0;
  let exited: () => void = () => {};
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const send = (message: MainToRunner) => listener?.({ data: message });

  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path.endsWith("/token"))
      return Response.json({
        access_token: "tok",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (path.endsWith("/heartbeat")) return new Response(null, { status: 204 });
    if (path.endsWith("/stream")) {
      streamCount += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          open = controller;
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return route({ method, path, body: typeof init?.body === "string" ? init.body : null });
  }) as typeof fetch;
  const previous = globalThis.fetch;
  globalThis.fetch = fake;

  const port: RunnerPort = {
    postMessage(message) {
      posted.push(message);
      if (message.type === "sign_assertion")
        queueMicrotask(() =>
          send({ type: "signed", request_id: message.request_id, signature: "sig" }),
        );
    },
    on(_event, next) {
      listener = next;
    },
  };
  const report: ReportPort = {
    failed: (scope, error) =>
      problems.push({
        scope,
        error_class: error instanceof TypeError ? "network" : "unexpected",
        status: null,
        repeats: 0,
      }),
  };
  runRunner(port, { exit: () => exited(), report });
  const config: RunnerConfig = {
    server_origin: "https://subkit.example",
    device_runner_id: "r1",
    ledger_path: ledger,
    runner_version: "12.1.0",
    locale: "en",
    os: "darwin",
    capabilities: ["files"],
    generation: 0,
    unreported_stop: null,
    files: EMPTY_FILES_SNAPSHOT,
    browser: null,
    computer: COMPUTER_OFF,
  };
  send({ type: "start", config });

  return {
    posted,
    calls,
    problems,
    announce(commandId) {
      open?.enqueue(
        encoder.encode(
          `event: command.available\ndata: ${JSON.stringify({ command_id: commandId })}\n\n`,
        ),
      );
    },
    dropStream() {
      open?.close();
    },
    streams: () => streamCount,
    async shutdown() {
      send({ type: "shutdown" });
      await exit;
      globalThis.fetch = previous;
    },
  };
}

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the runner did not get there in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
