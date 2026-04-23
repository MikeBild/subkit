import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type React from "react";
import { engineHost, Footer, layoutFooterLines, MODE_LABELS } from "../repl/footer.tsx";

function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
}

function renderFooter(props: Partial<React.ComponentProps<typeof Footer>> = {}) {
  const tenant = "tenant" in props ? (props.tenant ?? null) : "acme";
  const sessionId = "sessionId" in props ? (props.sessionId ?? null) : null;
  return render(
    <Footer
      user={props.user ?? "alice@example.com"}
      tenant={tenant}
      engineUrl={props.engineUrl ?? "https://subkit-api.example.dev"}
      sessionId={sessionId}
      mode={props.mode ?? "ask"}
      transcriptMode={props.transcriptMode ?? "chat"}
    />,
  );
}

describe("engineHost", () => {
  test("strips scheme and path", () => {
    expect(engineHost("https://subkit-api.example.dev/v1")).toBe("subkit-api.example.dev");
  });

  test("keeps explicit port", () => {
    expect(engineHost("http://localhost:8080")).toBe("localhost:8080");
  });
});

describe("Footer identity", () => {
  test("renders user, tenant, host, and short session id", () => {
    const instance = renderFooter({
      sessionId: "abcd1234-0000-0000-0000-000000000000",
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("alice@example.com");
    expect(frame).toContain("@ acme");
    expect(frame).toContain("subkit-api.example.dev");
    expect(frame).toContain("session abcd1234");
    instance.unmount();
    cleanup();
  });

  test("renders `(no tenant)` when tenant is null", () => {
    const instance = renderFooter({ tenant: null });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("(no tenant)");
    instance.unmount();
    cleanup();
  });
});

describe("Footer mode and view", () => {
  test("ask mode shows compact labels and the inspect hint", () => {
    const instance = renderFooter({ mode: "ask", transcriptMode: "chat" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain(MODE_LABELS.ask);
    expect(frame).toContain("chat");
    expect(frame).toContain("shift+tab mode");
    expect(frame).toContain("ctrl-o inspect");
    instance.unmount();
    cleanup();
  });

  test("inspect view hints the next toggle back to chat", () => {
    const instance = renderFooter({ transcriptMode: "inspect" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("inspect");
    expect(frame).toContain("ctrl-o chat");
    instance.unmount();
    cleanup();
  });

  test("mode labels are short and subkit-native", () => {
    expect(MODE_LABELS.ask).toBe("ask");
    expect(MODE_LABELS.auto).toBe("auto");
    expect(MODE_LABELS.plan).toBe("plan");
  });

  test("narrow widths drop host and long hints before session + mode", () => {
    const layout = layoutFooterLines({
      user: "alice@example.com",
      tenant: "acme",
      engineUrl: "https://subkit-api.example.dev",
      sessionId: "abcd1234-0000-0000-0000-000000000000",
      mode: "ask",
      transcriptMode: "chat",
      columns: 22,
    });
    expect(layout.identityPrefix).toBe("session ");
    expect(layout.identityHighlight).toBe("abcd1234");
    expect(layout.modeLabel).toBe("ask");
    expect(layout.activitySuffix).toBe(" · chat");
  });
});
