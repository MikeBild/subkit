import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import {
  type FakeOAuthServer,
  startFakeOAuthServer,
} from "../../../../../tests/e2e/_helpers/fake-oauth.ts";
import { OAuthWaitView } from "../../domain/connectors/OAuthWaitView.tsx";
import { flush, renderInk } from "../helpers/ink.tsx";

let server: FakeOAuthServer;

beforeEach(async () => {
  server = await startFakeOAuthServer();
});
afterEach(async () => {
  await server.cleanup();
});

describe("integration: OAuthWaitView poll loop", () => {
  test("flips to connected when the fake server reports complete", async () => {
    const stateId = "abc";
    let credential: { id: string } | null = null;
    server.completeFlow(stateId, { id: "cred-xyz", scope: "read" });
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl={`${server.baseUrl}/auth?state=${stateId}`}
          poll={server.buildPoll(stateId)}
          openBrowser={async () => undefined}
          onConnected={(c) => {
            credential = c as { id: string };
          }}
          initialIntervalMs={5}
        />
      </ThemeProvider>,
    );
    try {
      // case via the test helper's `allow-wall-clock` annotation.
      await ui.waitFor(() => credential !== null, { tries: 100, sleepMs: 10 });
      expect(credential).not.toBeNull();
      expect((credential as unknown as { id: string } | null)?.id).toBe("cred-xyz");
    } finally {
      ui.unmount();
    }
  });

  test("surfaces user_denied when the fake server reports failed", async () => {
    const stateId = "denied";
    server.failFlow(stateId, "user_denied");
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl={`${server.baseUrl}/auth?state=${stateId}`}
          poll={server.buildPoll(stateId)}
          openBrowser={async () => undefined}
          onConnected={() => undefined}
          initialIntervalMs={5}
        />
      </ThemeProvider>,
    );
    try {
      await ui.waitFor((t) => t.includes("user_denied"), { tries: 100, sleepMs: 10 });
      expect(ui.text()).toContain("user_denied");
    } finally {
      ui.unmount();
    }
  });

  test("manual fallback when browser launch fails", async () => {
    const stateId = "manual";
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl={`${server.baseUrl}/auth?state=${stateId}`}
          poll={server.buildPoll(stateId)}
          openBrowser={async () => {
            throw new Error("no browser available");
          }}
          onConnected={() => undefined}
        />
      </ThemeProvider>,
    );
    try {
      for (let i = 0; i < 200; i++) {
        await flush();
        if (ui.text().includes("browser launch failed")) break;
      }
      expect(ui.text()).toContain("browser launch failed");
    } finally {
      ui.unmount();
    }
  });
});
