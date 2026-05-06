import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { OAuthWaitView } from "../domain/connectors/OAuthWaitView.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("<OAuthWaitView>", () => {
  test("renders the auth URL and a launching indicator initially", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl="https://login.example.com/oauth?state=abc"
          poll={async () => ({ status: "pending" })}
          onConnected={() => undefined}
          openBrowser={async () => {
            // Block the browser launch so we stay in `launching` state long enough to assert.
            await new Promise((r) => setTimeout(r, 50));
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const text = ui.text();
      expect(text).toContain("authorize the connection");
      expect(text).toContain("https://login.example.com/oauth?state=abc");
    } finally {
      ui.unmount();
    }
  });

  test("calls onConnected with the credential on a `complete` poll", async () => {
    let credential: { id: string } | null = null;
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl="https://x"
          poll={async () => ({ status: "complete", credential: { id: "cred-1" } })}
          onConnected={(c) => {
            credential = c as { id: string };
          }}
          openBrowser={async () => undefined}
          initialIntervalMs={5}
        />
      </ThemeProvider>,
    );
    try {
      // Wait for the poll to resolve and the effect to fire.
      for (let i = 0; i < 40 && credential === null; i++) {
        await flush();
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(credential).not.toBeNull();
      expect((credential as unknown as { id: string } | null)?.id).toBe("cred-1");
    } finally {
      ui.unmount();
    }
  });

  test("falls back to manual mode when the browser launch fails", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl="https://x"
          poll={async () => ({ status: "pending" })}
          onConnected={() => undefined}
          openBrowser={async () => {
            throw new Error("no browser");
          }}
        />
      </ThemeProvider>,
    );
    try {
      // Walk a few flushes for the effect chain to settle.
      for (let i = 0; i < 20; i++) {
        await flush();
        if (ui.text().includes("browser launch failed")) break;
      }
      expect(ui.text()).toContain("browser launch failed");
    } finally {
      ui.unmount();
    }
  });

  test("surfaces a `failed` poll error", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <OAuthWaitView
          authUrl="https://x"
          poll={async () => ({ status: "failed", error: "user_denied" })}
          onConnected={() => undefined}
          openBrowser={async () => undefined}
          initialIntervalMs={5}
        />
      </ThemeProvider>,
    );
    try {
      for (let i = 0; i < 40; i++) {
        await flush();
        await new Promise((r) => setTimeout(r, 10));
        if (ui.text().includes("user_denied")) break;
      }
      expect(ui.text()).toContain("user_denied");
    } finally {
      ui.unmount();
    }
  });
});
