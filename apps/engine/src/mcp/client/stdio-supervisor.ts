import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { scrubString } from "@shared/index.ts";
import type { DecryptedCredential } from "../../credentials/index.ts";
import type { Executor } from "../../db/index.ts";
import { type EnvKey, readEnv } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import { type McpConnectorRow, McpPreflightError, type McpStdioRow } from "./registry.ts";
import { type StdioLimits, stdioGate, stdioLimits } from "./stdio-host.ts";
import { type StdioCommandDisplay, stdioCommandDisplay } from "./stdio-identity.ts";

async function tenantOrigin(
  tenant_id: string,
  exec: Executor,
): Promise<"self_service" | "self_hosted"> {
  const { getTenant } = await import("../../identity/index.ts");
  const tenant = await getTenant(tenant_id, exec);
  return tenant?.origin === "self_hosted" ? "self_hosted" : "self_service";
}

export async function assertStdioAllowed(tenant_id: string, exec: Executor): Promise<void> {
  const decision = stdioGate(await tenantOrigin(tenant_id, exec));
  if (!decision.allowed) throw new McpPreflightError(decision.error_code, decision.message);
}

export class StdioCommandUnconfirmedError extends McpPreflightError {
  constructor(readonly command: StdioCommandDisplay) {
    super(
      "mcp_local_command_unconfirmed",
      `a person must confirm this local command before SubKit starts it: ${command.command_line}`,
    );
    this.name = "StdioCommandUnconfirmedError";
  }
}

export function assertStdioConfirmed(stdio: McpStdioRow): void {
  if (stdio.confirmed_command_hash === stdio.command_hash) return;
  throw new StdioCommandUnconfirmedError(stdioCommandDisplay(stdio));
}

export function stdioSecretEnv(
  stdio: McpStdioRow,
  credential: DecryptedCredential | null,
): Record<string, string> {
  if (stdio.env_secret_names.length === 0) return {};
  if (credential?.mode !== "header") {
    throw new McpPreflightError(
      "credential_missing",
      `the stdio MCP server needs secret env ${stdio.env_secret_names.join(", ")}; store their values in the connector credential (mode "header", one entry per env name)`,
    );
  }
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of stdio.env_secret_names) {
    const value = credential.headers[name];
    if (value === undefined || value.length === 0) missing.push(name);
    else out[name] = value;
  }
  if (missing.length > 0) {
    throw new McpPreflightError(
      "credential_missing",
      `the connector credential carries no value for secret env ${missing.join(", ")}`,
    );
  }
  return out;
}

const INHERITED_ENV: readonly EnvKey[] = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
];
const INHERITED_ENV_WIN32: readonly EnvKey[] = ["USERPROFILE", "APPDATA"];

export function stdioProcessEnv(
  stdio: Pick<McpStdioRow, "env">,
  secret_env: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const inherited =
    process.platform === "win32" ? [...INHERITED_ENV, ...INHERITED_ENV_WIN32] : INHERITED_ENV;
  for (const key of inherited) {
    const value = readEnv(key);
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "win32") {
    const systemRoot = readEnv("SYSTEMROOT");
    if (systemRoot !== undefined) env.SystemRoot = systemRoot;
  }
  return { ...env, ...stdio.env, ...secret_env };
}

const LIVE = new Map<string, SupervisedStdioTransport>();

export function liveStdioServerCount(): number {
  return LIVE.size;
}

export interface StdioLaunch {
  tenant_id: string;
  connector_id: string;
  connector_slug: string;
  environment: "dev" | "prod";
  stdio: McpStdioRow;
  secret_env: Record<string, string>;
}

type StopReason = "closed" | "idle" | "replaced" | "shutdown" | "exited";

export class SupervisedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly key: string;
  private readonly inner: StdioClientTransport;
  private readonly limits: StdioLimits;
  private readonly pending = new Set<string | number>();
  private stderrRing = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopReason: StopReason | null = null;
  private started = false;

  constructor(private readonly launch: StdioLaunch) {
    this.key = `${launch.tenant_id}:${launch.connector_id}:${launch.environment}`;
    this.limits = stdioLimits();
    this.inner = new StdioClientTransport({
      command: launch.stdio.command,
      args: launch.stdio.args,
      env: stdioProcessEnv(launch.stdio, launch.secret_env),
      ...(launch.stdio.cwd ? { cwd: launch.stdio.cwd } : {}),
      stderr: "pipe",
    });
    this.inner.stderr?.on("data", (chunk: Buffer | string) => this.appendStderr(chunk));
  }

  get commandLine(): string {
    return stdioCommandDisplay(this.launch.stdio).command_line;
  }

  get pid(): number | null {
    return this.inner.pid;
  }

  stderrTail(): string {
    let text = this.stderrRing;
    for (const value of Object.values(this.launch.secret_env)) {
      if (value.length >= 4) text = text.replaceAll(value, "***REDACTED:secret_env***");
    }
    return scrubString(text).trim();
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("stdio transport already started");
    this.started = true;
    const previous = LIVE.get(this.key);
    const others = previous ? LIVE.size - 1 : LIVE.size;
    if (others >= this.limits.max_processes) {
      throw new McpPreflightError(
        "mcp_stdio_capacity",
        `this engine already runs ${others} stdio MCP server(s), the limit set in connectors.mcp.stdio_limits.max_processes; stop one or raise the limit`,
      );
    }
    if (previous) await previous.stop("replaced");
    LIVE.set(this.key, this);
    this.inner.onmessage = (message) => this.receive(message);
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.handleClose();
    try {
      await this.inner.start();
    } catch (error) {
      this.release();
      throw this.startFailure(error);
    }
    logger.info({
      module: "mcp_client",
      action: "stdio.started",
      msg: "started stdio MCP server process",
      tenant_id: this.launch.tenant_id,
      connector_id: this.launch.connector_id,
      connector_slug: this.launch.connector_slug,
      pid: this.inner.pid,
    });
    this.armIdle();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const request = message as { id?: string | number; method?: unknown };
    if (request.id !== undefined && typeof request.method === "string") {
      this.pending.add(request.id);
      this.disarmIdle();
    }
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    await this.stop("closed");
  }

  async stop(reason: StopReason): Promise<void> {
    if (this.stopReason === null) this.stopReason = reason;
    this.disarmIdle();
    this.release();
    await this.inner.close();
  }

  startFailure(error: unknown): McpPreflightError {
    if (error instanceof McpPreflightError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    const tail = this.stderrTail();
    return new McpPreflightError(
      "mcp_stdio_start_failed",
      `the stdio MCP server '${this.commandLine}' did not start: ${scrubString(detail)}${tail ? ` — stderr: ${tail}` : ""}`,
    );
  }

  private receive(message: JSONRPCMessage): void {
    const response = message as { id?: string | number; method?: unknown };
    if (response.id !== undefined && response.method === undefined) {
      this.pending.delete(response.id);
      if (this.pending.size === 0) this.armIdle();
    }
    this.onmessage?.(message);
  }

  private appendStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const joined = this.stderrRing + text;
    const max = this.limits.stderr_ring_bytes;
    this.stderrRing = joined.length > max ? joined.slice(joined.length - max) : joined;
  }

  private armIdle(): void {
    this.disarmIdle();
    if (this.stopReason !== null || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => void this.idleStop(), this.limits.idle_timeout_ms);
    this.idleTimer.unref?.();
  }

  private disarmIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async idleStop(): Promise<void> {
    if (this.stopReason !== null || this.pending.size > 0) return;
    this.stopReason = "idle";
    logger.info({
      module: "mcp_client",
      action: "stdio.idle_stopped",
      msg: "stopped idle stdio MCP server process",
      tenant_id: this.launch.tenant_id,
      connector_id: this.launch.connector_id,
      idle_timeout_ms: this.limits.idle_timeout_ms,
    });
    await evictFromPool(this.launch.tenant_id, this.launch.connector_id);
    await this.stop("idle");
  }

  private handleClose(): void {
    this.disarmIdle();
    const reason = this.stopReason;
    this.release();
    if (reason === null) {
      this.stopReason = "exited";
      logger.warn({
        module: "mcp_client",
        action: "stdio.exited",
        msg: "stdio MCP server process exited on its own",
        tenant_id: this.launch.tenant_id,
        connector_id: this.launch.connector_id,
        stderr: this.stderrTail().slice(-1_000),
      });
      void evictFromPool(this.launch.tenant_id, this.launch.connector_id);
    }
    this.onclose?.();
  }

  private release(): void {
    if (LIVE.get(this.key) === this) LIVE.delete(this.key);
  }
}

async function evictFromPool(tenant_id: string, connector_id: string): Promise<void> {
  try {
    const { evictServer } = await import("./pool.ts");
    evictServer(tenant_id, connector_id);
  } catch (error) {
    logStopFailure("pool_evict_failed", error);
  }
}

export function startStdioTransport(launch: StdioLaunch): SupervisedStdioTransport {
  return new SupervisedStdioTransport(launch);
}

export async function connectStdioClient(
  client: { connect(transport: Transport): Promise<void> },
  transport: Transport,
): Promise<void> {
  if (!(transport instanceof SupervisedStdioTransport)) {
    await client.connect(transport);
    return;
  }
  const timeoutMs = stdioLimits().startup_timeout_ms;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const tail = transport.stderrTail();
      reject(
        new McpPreflightError(
          "mcp_stdio_start_failed",
          `the stdio MCP server '${transport.commandLine}' did not answer the MCP handshake within ${timeoutMs} ms${tail ? ` — stderr: ${tail}` : ""}`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport), timedOut]);
  } catch (error) {
    await transport.stop("closed").catch((stopError: unknown) => {
      logStopFailure("stop_after_start_failure_failed", stopError);
    });
    throw transport.startFailure(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logStopFailure(action: string, error: unknown): void {
  logger.warn({
    module: "mcp_stdio",
    action,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function stopAllStdioServers(): Promise<void> {
  const live = [...LIVE.values()];
  await Promise.all(
    live.map((transport) =>
      transport.stop("shutdown").catch((error: unknown) => {
        logStopFailure("shutdown_stop_failed", error);
      }),
    ),
  );
}

export function stdioRowOf(row: McpConnectorRow): McpStdioRow {
  if (row.transport !== "stdio" || !row.stdio) {
    throw new McpPreflightError(
      "config_incomplete",
      "this MCP connector has no stdio command; set config.mcp.command",
    );
  }
  return row.stdio;
}
