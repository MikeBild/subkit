import { existsSync } from "node:fs";
import { currentDeploymentMode, getConfig, isConfigLoaded } from "../../config/index.ts";
import { readEnv } from "../../env.ts";

export const STDIO_CONTAINER_MESSAGE =
  "stdio MCP servers need SubKit Desktop or an engine running directly on the host; inside Docker use http://host.docker.internal:<port>";

const STDIO_DISABLED_MESSAGE =
  "stdio MCP servers are turned off on this engine; set connectors.mcp.stdio to on, or use an http MCP server";

const STDIO_HOSTED_MESSAGE =
  "stdio MCP servers are not available on hosted workspaces; run the server yourself and connect it over https";

export interface StdioLimits {
  startup_timeout_ms: number;
  idle_timeout_ms: number;
  max_processes: number;
  stderr_ring_bytes: number;
}

const DEFAULT_LIMITS: StdioLimits = {
  startup_timeout_ms: 30_000,
  idle_timeout_ms: 300_000,
  max_processes: 8,
  stderr_ring_bytes: 16_384,
};

interface StdioHostOverrides {
  container?: boolean;
  limits?: Partial<StdioLimits>;
  setting?: "auto" | "on" | "off";
  deployment_mode?: "server" | "local_workspace";
}

let hostOverrides: StdioHostOverrides | null = null;

export function __setStdioHostForTests(overrides: StdioHostOverrides | null): void {
  hostOverrides = overrides;
}

export function stdioLimits(): StdioLimits {
  const configured = isConfigLoaded() ? getConfig().connectors.mcp.stdio_limits : DEFAULT_LIMITS;
  return { ...DEFAULT_LIMITS, ...configured, ...(hostOverrides?.limits ?? {}) };
}

function stdioSetting(): "auto" | "on" | "off" {
  if (hostOverrides?.setting) return hostOverrides.setting;
  return isConfigLoaded() ? getConfig().connectors.mcp.stdio : "auto";
}

export function runningInContainer(): boolean {
  if (hostOverrides?.container !== undefined) return hostOverrides.container;
  return readEnv("SUBKIT_CONTAINER") === "1" || existsSync("/.dockerenv");
}

export type StdioGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      error_code: "mcp_stdio_disabled" | "mcp_stdio_unavailable_in_container";
      message: string;
    };

export function stdioGate(origin: "self_service" | "self_hosted"): StdioGateDecision {
  if (origin === "self_service") {
    return { allowed: false, error_code: "mcp_stdio_disabled", message: STDIO_HOSTED_MESSAGE };
  }
  const setting = stdioSetting();
  if (setting === "off") {
    return { allowed: false, error_code: "mcp_stdio_disabled", message: STDIO_DISABLED_MESSAGE };
  }
  if (runningInContainer()) {
    return {
      allowed: false,
      error_code: "mcp_stdio_unavailable_in_container",
      message: STDIO_CONTAINER_MESSAGE,
    };
  }
  const mode = hostOverrides?.deployment_mode ?? currentDeploymentMode();
  if (setting === "auto" && mode !== "local_workspace") {
    return { allowed: false, error_code: "mcp_stdio_disabled", message: STDIO_DISABLED_MESSAGE };
  }
  return { allowed: true };
}
