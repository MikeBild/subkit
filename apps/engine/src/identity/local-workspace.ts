import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { LOCAL_PORT_ENV, LOCAL_READY_EVENT } from "@shared/device/local-launch.ts";
import { z } from "zod";
import type { DeploymentMode } from "../config/deployment-mode.ts";
import { createPowerState, type PowerState } from "../scheduler/power-state.ts";

export const LOCAL_LAUNCH_TIMEOUT_MS = 30_000;
export const LOCAL_LOOPBACK = "127.0.0.1";
const LAUNCH_LINE_MAX_BYTES = 4096;

export const LOCAL_UNAVAILABLE_CAPABILITIES = [
  "inbound_hooks",
  "portal_tokens",
  "public_mcp",
  "push",
] as const;

export type LocalUnavailableCapability = (typeof LOCAL_UNAVAILABLE_CAPABILITIES)[number];

const LOCAL_UNAVAILABLE_ROUTES: ReadonlyArray<{
  method: string;
  path: string;
  capability: LocalUnavailableCapability;
}> = [
  { method: "POST", path: "/v1/webhooks/inbound", capability: "inbound_hooks" },
  { method: "POST", path: "/v1/identity/portal-tokens", capability: "portal_tokens" },
  { method: "POST", path: "/v1/cockpit/push-subscription/prepare", capability: "push" },
  { method: "PUT", path: "/v1/cockpit/push-subscription", capability: "push" },
];

const PortSchema = z.coerce.number().int().min(1024).max(65535);

export const LocalLaunchSchema = z
  .object({ launch_secret: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) })
  .strict();

export type LocalLaunch = z.infer<typeof LocalLaunchSchema>;

export interface LocalWorkspace {
  readonly preferredPort: number | null;
  port: number | null;
  launchSecret: string | null;
  readonly power: PowerState;
}

export interface LocalPortChoice {
  port: number;
  reassigned: boolean;
}

export function localWorkspaceFor(
  mode: DeploymentMode,
  env: Record<string, string | undefined>,
): LocalWorkspace | null {
  if (mode !== "local_workspace") return null;
  const raw = env[LOCAL_PORT_ENV]?.trim();
  const power = createPowerState();
  if (!raw) return { preferredPort: null, port: null, launchSecret: null, power };
  const parsed = PortSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${LOCAL_PORT_ENV}="${raw}" is not a port in 1024..65535`);
  return { preferredPort: parsed.data, port: null, launchSecret: null, power };
}

export function unavailableLocally(
  method: string,
  path: string,
): LocalUnavailableCapability | null {
  return (
    LOCAL_UNAVAILABLE_ROUTES.find((route) => route.method === method && route.path === path)
      ?.capability ?? null
  );
}

function listenOnce(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(null));
    probe.listen({ host: LOCAL_LOOPBACK, port, exclusive: true }, () => {
      const address = probe.address();
      const bound = typeof address === "object" && address ? address.port : null;
      probe.close(() => resolve(bound));
    });
  });
}

export async function chooseLocalPort(
  preferred: number | null,
  listen: (port: number) => Promise<number | null> = listenOnce,
): Promise<LocalPortChoice> {
  if (preferred !== null && (await listen(preferred)) === preferred)
    return { port: preferred, reassigned: false };
  const fresh = await listen(0);
  if (fresh === null) throw new Error("no free loopback port for the local engine");
  return { port: fresh, reassigned: preferred !== null };
}

export function localReadyLine(choice: LocalPortChoice): string {
  return `${JSON.stringify({ event: LOCAL_READY_EVENT, port: choice.port, reassigned: choice.reassigned })}\n`;
}

export function parseLocalLaunchLine(line: string): LocalLaunch {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("the local launch line is not JSON");
  }
  const parsed = LocalLaunchSchema.safeParse(raw);
  if (!parsed.success) throw new Error("the local launch line is not a valid launch payload");
  return parsed.data;
}

export function readLaunchLine(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = LOCAL_LAUNCH_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (error: Error | null, line = "") => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.pause();
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) finish(null, buffered.slice(0, newline).trim());
      else if (buffered.length > LAUNCH_LINE_MAX_BYTES)
        finish(new Error("the local launch line is too long"));
    };
    const onEnd = () => finish(new Error("stdin closed before the local launch line arrived"));
    const timer = setTimeout(
      () => finish(new Error(`no local launch line on stdin within ${timeoutMs} ms`)),
      timeoutMs,
    );
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.resume();
  });
}

export function watchLauncherExit(stream: NodeJS.ReadableStream, onGone: () => void): void {
  stream.once("end", onGone);
  stream.once("close", onGone);
  stream.resume();
}

export async function completeLocalLaunch(
  workspace: LocalWorkspace,
  choice: LocalPortChoice,
  io: { out: { write(chunk: string): unknown }; input: NodeJS.ReadableStream },
  timeoutMs: number = LOCAL_LAUNCH_TIMEOUT_MS,
): Promise<void> {
  workspace.port = choice.port;
  io.out.write(localReadyLine(choice));
  const launch = parseLocalLaunchLine(await readLaunchLine(io.input, timeoutMs));
  workspace.launchSecret = launch.launch_secret;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function launchSecretMatches(
  expected: string | null,
  presented: string | undefined,
): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(digest(expected), digest(presented));
}

export function localHostAllowed(host: string | undefined, port: number | null): boolean {
  return port !== null && host === `${LOCAL_LOOPBACK}:${port}`;
}

export async function attachLocalLauncher(
  workspace: LocalWorkspace,
  choice: LocalPortChoice,
  onGone: () => void,
): Promise<void> {
  await completeLocalLaunch(workspace, choice, { out: process.stdout, input: process.stdin });
  watchLauncherExit(process.stdin, onGone);
}
