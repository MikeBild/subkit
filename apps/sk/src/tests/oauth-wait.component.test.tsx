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
          openBrowser={() =>
            // Returns a promise that never resolves so we stay in
            // `launching` state. No wall-clock timer required.
            new Promise<void>(() => undefined)
          }
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
      // The poll loop schedules ticks via setTimeout, which is a
      // macrotask — flush() alone (microtasks) won't advance it.
      // ui.waitFor's `sleepMs` opts into wall-clock progress for
      // exactly this case (backoff schedule).
      await ui.waitFor(() => credential !== null, { tries: 100, sleepMs: 10 });
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
      // Same backoff caveat as the complete-poll test above —
      // setTimeout-based ticks need wall-clock progress.
      await ui.waitFor((t) => t.includes("user_denied"), { tries: 100, sleepMs: 10 });
      expect(ui.text()).toContain("user_denied");
    } finally {
      ui.unmount();
    }
  });
});
