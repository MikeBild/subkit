import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpPreflightError, type McpStdioRow } from "./registry.ts";
import { __setStdioHostForTests, STDIO_CONTAINER_MESSAGE, stdioGate } from "./stdio-host.ts";
import { stdioCommandHash } from "./stdio-identity.ts";
import {
  assertStdioConfirmed,
  connectStdioClient,
  liveStdioServerCount,
  StdioCommandUnconfirmedError,
  startStdioTransport,
  stdioProcessEnv,
  stdioSecretEnv,
  stopAllStdioServers,
} from "./stdio-supervisor.ts";

const FIXTURE = new URL("./tests/fixtures/stdio-echo-server.ts", import.meta.url).pathname;
const FIXTURE_DIR = new URL("./tests/fixtures/", import.meta.url).pathname;

function fixtureRow(overrides: Partial<McpStdioRow> = {}): McpStdioRow {
  const spec = {
    command: process.execPath,
    args: ["--no-env-file", FIXTURE],
    env: { FIXTURE_FLAG: "on" },
    cwd: FIXTURE_DIR,
    env_secret_names: [],
    ...overrides,
  };
  const command_hash = stdioCommandHash(spec);
  return { ...spec, command_hash, confirmed_command_hash: command_hash };
}

let connectorSeq = 0;

function launch(stdio: McpStdioRow, secret_env: Record<string, string> = {}) {
  connectorSeq += 1;
  return startStdioTransport({
    tenant_id: "00000000-0000-4000-8000-000000000001",
    connector_id: `00000000-0000-4000-8000-${String(connectorSeq).padStart(12, "0")}`,
    connector_slug: `stdio-${connectorSeq}`,
    environment: "prod",
    stdio,
    secret_env,
  });
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]?.text ?? "";
}

afterEach(async () => {
  await stopAllStdioServers();
  __setStdioHostForTests(null);
});

describe("stdio gate", () => {
  test("auto starts stdio only in the local workspace", () => {
    __setStdioHostForTests({ setting: "auto", container: false, deployment_mode: "server" });
    expect(stdioGate("self_hosted")).toMatchObject({
      allowed: false,
      error_code: "mcp_stdio_disabled",
    });
    __setStdioHostForTests({
      setting: "auto",
      container: false,
      deployment_mode: "local_workspace",
    });
    expect(stdioGate("self_hosted")).toEqual({ allowed: true });
  });

  test("on starts stdio on a host engine and is refused inside a container", () => {
    __setStdioHostForTests({ setting: "on", container: false, deployment_mode: "server" });
    expect(stdioGate("self_hosted")).toEqual({ allowed: true });
    __setStdioHostForTests({ setting: "on", container: true, deployment_mode: "server" });
    expect(stdioGate("self_hosted")).toEqual({
      allowed: false,
      error_code: "mcp_stdio_unavailable_in_container",
      message: STDIO_CONTAINER_MESSAGE,
    });
  });

  test("off refuses stdio everywhere", () => {
    __setStdioHostForTests({
      setting: "off",
      container: false,
      deployment_mode: "local_workspace",
    });
    expect(stdioGate("self_hosted")).toMatchObject({ error_code: "mcp_stdio_disabled" });
  });

  test("a hosted self-service workspace never starts stdio", () => {
    __setStdioHostForTests({
      setting: "on",
      container: false,
      deployment_mode: "local_workspace",
    });
    expect(stdioGate("self_service")).toMatchObject({
      allowed: false,
      error_code: "mcp_stdio_disabled",
    });
  });
});

describe("stdio confirmation", () => {
  test("an unconfirmed command is refused with the literal command", () => {
    const row = { ...fixtureRow({ args: ["mcp", "gateway", "run"] }), command: "docker" };
    const unconfirmed = { ...row, command_hash: stdioCommandHash(row) };
    let caught: unknown;
    try {
      assertStdioConfirmed(unconfirmed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StdioCommandUnconfirmedError);
    const error = caught as StdioCommandUnconfirmedError;
    expect(error.error_code).toBe("mcp_local_command_unconfirmed");
    expect(error.command.command_line).toBe("docker mcp gateway run");
    expect(error.message).toContain("docker mcp gateway run");
  });

  test("a confirmed command passes", () => {
    expect(() => assertStdioConfirmed(fixtureRow())).not.toThrow();
  });
});

describe("stdio environment", () => {
  test("passes only the allow-listed engine env plus declared and secret env", () => {
    const env = stdioProcessEnv({ env: { LOG_LEVEL: "debug" } }, { GITHUB_TOKEN: "ghp_x" });
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.GITHUB_TOKEN).toBe("ghp_x");
    expect(env.PATH).toBeDefined();
    expect(Object.keys(env)).not.toContain("MASTER_KEY");
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
  });

  test("secret env comes from the header-mode credential by name", () => {
    const row = fixtureRow({ env_secret_names: ["API_TOKEN"] });
    expect(stdioSecretEnv(row, { mode: "header", headers: { API_TOKEN: "t0k" } })).toEqual({
      API_TOKEN: "t0k",
    });
    expect(() => stdioSecretEnv(row, null)).toThrow(McpPreflightError);
    expect(() => stdioSecretEnv(row, { mode: "header", headers: {} })).toThrow(
      /no value for secret env API_TOKEN/,
    );
  });
});

describe("stdio supervisor", () => {
  test("spawns the server, lists tools and keeps the engine env out", async () => {
    const transport = launch(fixtureRow({ env_secret_names: ["FIXTURE_SECRET"] }), {
      FIXTURE_SECRET: "s3cr3t-value",
    });
    const client = new Client({ name: "t", version: "1" });
    await connectStdioClient(client, transport);
    expect(liveStdioServerCount()).toBe(1);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["echo", "env_dump"]);
    expect(textOf(await client.callTool({ name: "echo", arguments: { text: "hi" } }))).toBe("hi");
    const env = JSON.parse(textOf(await client.callTool({ name: "env_dump", arguments: {} })));
    expect(env.FIXTURE_FLAG).toBe("on");
    expect(env.MASTER_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(transport.stderrTail()).toContain("stdio-echo ready");
    expect(env.FIXTURE_SECRET).toBe("s3cr3t-value");
    expect(transport.stderrTail()).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(transport.stderrTail()).not.toContain("s3cr3t-value");
    await client.close();
    expect(liveStdioServerCount()).toBe(0);
  });

  test("stops an idle server", async () => {
    __setStdioHostForTests({ limits: { idle_timeout_ms: 200 } });
    const transport = launch(fixtureRow());
    const closed = new Promise<void>((resolve) => {
      const client = new Client({ name: "t", version: "1" });
      client.onclose = () => resolve();
      void connectStdioClient(client, transport);
    });
    await closed;
    expect(liveStdioServerCount()).toBe(0);
    expect(transport.pid).toBeNull();
  });

  test("refuses a start beyond max_processes", async () => {
    __setStdioHostForTests({ limits: { max_processes: 1 } });
    const first = new Client({ name: "t", version: "1" });
    await connectStdioClient(first, launch(fixtureRow()));
    let caught: unknown;
    try {
      await connectStdioClient(new Client({ name: "t", version: "1" }), launch(fixtureRow()));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpPreflightError);
    expect((caught as McpPreflightError).error_code).toBe("mcp_stdio_capacity");
    expect(liveStdioServerCount()).toBe(1);
    await first.close();
  });

  test("a command that cannot start reports mcp_stdio_start_failed", async () => {
    const row = fixtureRow({ command: "/nonexistent/subkit-stdio-fixture", args: [] });
    let caught: unknown;
    try {
      await connectStdioClient(new Client({ name: "t", version: "1" }), launch(row));
    } catch (error) {
      caught = error;
    }
    expect((caught as McpPreflightError).error_code).toBe("mcp_stdio_start_failed");
    expect(liveStdioServerCount()).toBe(0);
  });

  test("a server that never answers the handshake times out", async () => {
    __setStdioHostForTests({ limits: { startup_timeout_ms: 300 } });
    const row = fixtureRow({ args: ["-e", "setInterval(() => {}, 1000)"] });
    let caught: unknown;
    try {
      await connectStdioClient(new Client({ name: "t", version: "1" }), launch(row));
    } catch (error) {
      caught = error;
    }
    expect((caught as McpPreflightError).error_code).toBe("mcp_stdio_start_failed");
    expect((caught as Error).message).toContain("within 300 ms");
    expect(liveStdioServerCount()).toBe(0);
  });

  test("engine shutdown stops every server", async () => {
    const client = new Client({ name: "t", version: "1" });
    await connectStdioClient(client, launch(fixtureRow()));
    expect(liveStdioServerCount()).toBe(1);
    await stopAllStdioServers();
    expect(liveStdioServerCount()).toBe(0);
  });
});
