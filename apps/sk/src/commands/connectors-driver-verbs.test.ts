import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };

const realEngineClient = await import("../engine-client.ts");
const realConfig = await import("../config.ts");

const ORIGINAL_ENGINE_CLIENT = { ...realEngineClient };
const ORIGINAL_CONFIG = { ...realConfig };

const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";

const ENABLEMENT_FIELD = "enabled";

const ENABLED = { id: CONNECTOR_ID, slug: "rovo", driver: "mcp", [ENABLEMENT_FIELD]: true };
const DISABLED = { ...ENABLED, [ENABLEMENT_FIELD]: false };

const INSPECT_RESULT = {
  connector_id: CONNECTOR_ID,
  slug: "rovo",
  tools: [{ name: "search", description: "Search pages", claims: "read" }],
  capabilities: { tools: true, resources: false, prompts: false },
  instructions: "Use search before create.",
  server_version: { name: "rovo", version: "1.0.0" },
};

const AUTHORIZE_RESULT = {
  authorization_url: "https://idp.example.test/authorize?client_id=abc&code_challenge=xyz",
  state: "3f1c9a52-0000-4000-8000-000000000001",
};

const calls: { method: string; id: string }[] = [];

let nextError: Error | null = null;

function record(method: string, id: string): void {
  calls.push({ method, id });
  if (nextError) {
    const err = nextError;
    nextError = null;
    throw err;
  }
}

mock.module("../engine-client.ts", () => ({
  ...ORIGINAL_ENGINE_CLIENT,
  EngineClient: class StubEngineClient {
    async enableConnector(id: string) {
      record("enableConnector", id);
      return ENABLED;
    }
    async disableConnector(id: string) {
      record("disableConnector", id);
      return DISABLED;
    }
    async inspectMcpConnector(id: string) {
      record("inspectMcpConnector", id);
      return INSPECT_RESULT;
    }
    async authorizeMcpConnector(id: string) {
      record("authorizeMcpConnector", id);
      return AUTHORIZE_RESULT;
    }
    async listConnectors() {
      calls.push({ method: "listConnectors", id: "" });
      return { items: [], total: 0, categories: [] };
    }
  },
}));

mock.module("../config.ts", () => ({
  ...ORIGINAL_CONFIG,
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-stub",
  }),
}));

import { connectorsCommand } from "./connectors.ts";

type CittySub = { run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown> };

function verb(name: string): CittySub {
  const subs = (connectorsCommand as { subCommands?: Record<string, CittySub> }).subCommands;
  const sub = subs?.[name];
  if (!sub?.run) throw new Error(`expected subCommands.${name}.run on the connectors command`);
  return sub;
}

let stdoutBuf = "";
let stderrBuf = "";
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  calls.length = 0;
  nextError = null;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

afterAll(() => {
  mock.module("../engine-client.ts", () => ORIGINAL_ENGINE_CLIENT);
  mock.module("../config.ts", () => ORIGINAL_CONFIG);
});

describe("the enablement fixture matches the engine's own resource", () => {
  test("`enabled` is a real property of Connector in the committed schema", () => {
    const connector = (
      openapi as {
        components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
      }
    ).components.schemas.Connector;
    const properties = Object.keys(connector?.properties ?? {});
    expect(properties.length).toBeGreaterThan(5);
    expect(properties).toContain(ENABLEMENT_FIELD);
    expect(properties).not.toContain("status");
  });
});

describe("sk connectors enable", () => {
  test("calls enableConnector with the given id and prints the resource", async () => {
    await verb("enable").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "enableConnector", id: CONNECTOR_ID }]);
    expect(JSON.parse(stdoutBuf.trim())).toEqual(ENABLED);
    expect(stderrBuf).toBe("");
  });
});

describe("sk connectors disable", () => {
  test("calls disableConnector with the given id and prints the resource", async () => {
    await verb("disable").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "disableConnector", id: CONNECTOR_ID }]);
    expect(JSON.parse(stdoutBuf.trim())).toEqual(DISABLED);
    expect(stderrBuf).toBe("");
  });

  test("enable and disable are separate calls — neither is an alias of the other", async () => {
    await verb("enable").run!({ args: { id: CONNECTOR_ID } });
    await verb("disable").run!({ args: { id: CONNECTOR_ID } });
    expect(calls.map((c) => c.method)).toEqual(["enableConnector", "disableConnector"]);
  });
});

describe("sk connectors mcp-inspect", () => {
  test("prints the handshake result verbatim, tools included", async () => {
    await verb("mcp-inspect").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "inspectMcpConnector", id: CONNECTOR_ID }]);
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(parsed).toEqual(INSPECT_RESULT);
    expect(stderrBuf).toBe("");
  });

  test("an engine refusal reaches stderr and leaves stdout empty", async () => {
    const { EngineError } = await import("@cli-core/errors");
    nextError = new EngineError(404, { code: "not_found", message: "mcp connector not found" });
    await expect(verb("mcp-inspect").run!({ args: { id: CONNECTOR_ID } })).rejects.toThrow(
      "mcp connector not found",
    );
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("mcp connector not found");
  });
});

describe("sk connectors mcp-authorize", () => {
  test("prints the authorization URL for the operator's browser", async () => {
    await verb("mcp-authorize").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "authorizeMcpConnector", id: CONNECTOR_ID }]);
    expect(stdoutBuf).toContain(AUTHORIZE_RESULT.authorization_url);
    expect(stderrBuf).toBe("");
  });

  test("does not print the correlation state", async () => {
    await verb("mcp-authorize").run!({ args: { id: CONNECTOR_ID } });
    expect(stdoutBuf).not.toContain(AUTHORIZE_RESULT.state);
  });

  test("a failed authorization start reaches stderr and prints no URL line", async () => {
    const { EngineError } = await import("@cli-core/errors");
    nextError = new EngineError(422, {
      code: "unprocessable_entity",
      message: "interactive authorization is only available for an oauth2 mcp connector",
    });
    await expect(verb("mcp-authorize").run!({ args: { id: CONNECTOR_ID } })).rejects.toThrow(
      "interactive authorization",
    );
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("interactive authorization");
  });
});

describe("the four verbs treat an omitted id the same way", () => {
  function withoutTty<T>(fn: () => Promise<T>): Promise<T> {
    const outWas = process.stdout.isTTY;
    const inWas = process.stdin.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    return fn().finally(() => {
      Object.defineProperty(process.stdout, "isTTY", { value: outWas, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: inWas, configurable: true });
    });
  }

  test.each(["enable", "disable", "mcp-inspect", "mcp-authorize"])(
    "%s without an id fails with the required-argument error and calls no verb",
    async (name) => {
      await expect(withoutTty(() => verb(name).run!({ args: {} }))).rejects.toThrow(
        "connector id is required",
      );
      expect(calls).toEqual([]);
    },
  );
});
