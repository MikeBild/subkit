import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { connectorHasCredential, runEngineOAuthFlow } from "./oauth-flow.ts";

describe("connectorHasCredential", () => {
  test("reads the credential state the connector contract carries", () => {
    expect(connectorHasCredential({ credential: null })).toBe(false);
    expect(connectorHasCredential({})).toBe(false);
    expect(connectorHasCredential({ credential: { mode: "bearer", connection: null } })).toBe(true);
    expect(
      connectorHasCredential({
        credential: {
          mode: "connection",
          connection: { id: "cn-1", name: "Google", state: "valid" },
        },
      }),
    ).toBe(true);
  });
});

describe("runEngineOAuthFlow", () => {
  test("returns without a browser when the engine offers no sign-in URL", async () => {
    const opened: string[] = [];
    const client = {
      startConnectorSignIn: async () => ({ authorization_url: "" }),
    } as unknown as EngineClient;
    await runEngineOAuthFlow(client, "c-1", (url) => opened.push(url));
    expect(opened).toEqual([]);
  });

  test("opens the browser and resolves when the callback event arrives", async () => {
    const opened: string[] = [];
    const client = {
      startConnectorSignIn: async () => ({ authorization_url: "https://auth.example.test/x" }),
      subscribeConnectorOAuthCallback: async (opts: { onSucceeded: () => void }) => {
        queueMicrotask(opts.onSucceeded);
      },
    } as unknown as EngineClient;
    await runEngineOAuthFlow(client, "c-1", (url) => opened.push(url));
    expect(opened).toEqual(["https://auth.example.test/x"]);
  });
});
