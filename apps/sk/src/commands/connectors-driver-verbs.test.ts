// Command-layer tests for the four driver-dispatched connector verbs:
// `enable`, `disable`, `mcp-inspect`, `mcp-authorize`.
//
// These verbs are the CLI half of the mcp driver: an operator turns a
// connector off, forces one handshake to see what the remote serves, or
// starts the browser authorization. Each one is a single client call plus a
// single rendering decision, and both halves are worth pinning — a verb
// wired to the wrong client method is invisible until someone runs it
// against a live engine.
//
// Follows the create-json-contract.test.ts pattern: EngineClient and
// resolveProfile are replaced via mock.module (no network, no ~/.sk),
// stdout/stderr are captured per test, and the originals are re-installed in
// afterAll because mock.restore() does not undo mock.module.

import openapi from "@cli-core/engine-api/openapi.json" with { type: "json" };
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realEngineClient = await import("../engine-client.ts");
const realConfig = await import("../config.ts");

const ORIGINAL_ENGINE_CLIENT = { ...realEngineClient };
const ORIGINAL_CONFIG = { ...realConfig };

const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";

/** The bit `enable` / `disable` flip, as the engine names it on `Connector`. */
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

// Every call the four verbs make, recorded so a test can assert both that
// the right method ran and that it got the id it was given.
const calls: { method: string; id: string }[] = [];

/** Set per test to make the next client call reject, so the error path can
 *  be exercised without a live engine. */
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
      // Reached only if a verb tries to open the interactive picker. The
      // tests below run non-TTY, where pickId must throw instead.
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

// ------------------------------------------------------- fixture is honest

describe("the enablement fixture matches the engine's own resource", () => {
  test("`enabled` is a real property of Connector in the committed schema", () => {
    // A stub is only worth asserting against if it has the shape the engine
    // returns. This fixture previously carried a `status: "active"` field
    // that no connector response has ever had, so every assertion below
    // would have kept passing after the real field was renamed away.
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

// ---------------------------------------------------------------- enable

describe("sk connectors enable", () => {
  test("calls enableConnector with the given id and prints the resource", async () => {
    await verb("enable").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "enableConnector", id: CONNECTOR_ID }]);
    expect(JSON.parse(stdoutBuf.trim())).toEqual(ENABLED);
    expect(stderrBuf).toBe("");
  });
});

// --------------------------------------------------------------- disable

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

// ----------------------------------------------------------- mcp-inspect

describe("sk connectors mcp-inspect", () => {
  test("prints the handshake result verbatim, tools included", async () => {
    await verb("mcp-inspect").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "inspectMcpConnector", id: CONNECTOR_ID }]);
    const parsed = JSON.parse(stdoutBuf.trim());
    // The whole point of the verb: an operator sees what the remote serves,
    // not a summary of it. Every field the engine returned survives.
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

// --------------------------------------------------------- mcp-authorize

describe("sk connectors mcp-authorize", () => {
  test("prints the authorization URL for the operator's browser", async () => {
    await verb("mcp-authorize").run!({ args: { id: CONNECTOR_ID } });
    expect(calls).toEqual([{ method: "authorizeMcpConnector", id: CONNECTOR_ID }]);
    expect(stdoutBuf).toContain(AUTHORIZE_RESULT.authorization_url);
    expect(stderrBuf).toBe("");
  });

  test("does not print the correlation state", async () => {
    await verb("mcp-authorize").run!({ args: { id: CONNECTOR_ID } });
    // `state` is the single-use token that authenticates the OAuth
    // callback. It has no operator-facing use, and a terminal is a place
    // things get pasted from, so it stays out of the output.
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

// ------------------------------------------------- omitted id, non-TTY

describe("the four verbs treat an omitted id the same way", () => {
  // Forced rather than assumed: `bun test` from an interactive terminal
  // leaves isTTY true, and the picker path would then reach for the
  // connector list instead of erroring.
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
      // Non-TTY is the scripted case: the picker must not open, so no
      // command silently blocks a CI job waiting for a keystroke.
      await expect(withoutTty(() => verb(name).run!({ args: {} }))).rejects.toThrow(
        "connector id is required",
      );
      expect(calls).toEqual([]);
    },
  );
});
