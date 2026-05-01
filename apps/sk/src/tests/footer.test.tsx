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

describe("Footer connection chip layout", () => {
  // Repro of session f00b8d1c at 101 cols: full identity (60 chars) +
  // " · ⟳ reconnecting · Unable to connect…<37 char reason>" (58 chars)
  // overflows the line, so Ink wraps mid-word. The picker MUST drop
  // back to a compact chip in this case so neither line wraps.
  test("long reconnect reason at moderate width falls back to compact chip", () => {
    const layout = layoutFooterLines({
      user: "mike@mikebild.com",
      tenant: "default",
      engineUrl: "http://localhost:3000",
      sessionId: "f00b8d1c-d453-482e-8aa3-27b35a1cb5aa",
      mode: "ask",
      transcriptMode: "chat",
      connectionState: "reconnecting",
      connectionReason: "Unable to connect. Is the computer able to reach localhost:3000?",
      columns: 101,
    });
    expect(layout.connectionVariant).toBe("compact");
    // Full identity should still fit since chip is compact (~17 chars).
    expect(layout.identityPrefix).toContain("@ default");
    expect(layout.identityPrefix).toContain("· localhost:3000");
  });

  test("wide terminal keeps the full chip with reason", () => {
    const layout = layoutFooterLines({
      user: "mike@mikebild.com",
      tenant: "default",
      engineUrl: "http://localhost:3000",
      sessionId: "f00b8d1c",
      mode: "ask",
      transcriptMode: "chat",
      connectionState: "reconnecting",
      connectionReason: "Unable to connect — engine offline",
      columns: 200,
    });
    expect(layout.connectionVariant).toBe("full");
  });

  test("identity collapses BEFORE the chip drops to none — chip is non-negotiable when state is bad", () => {
    const layout = layoutFooterLines({
      user: "mike@mikebild.com",
      tenant: "default",
      engineUrl: "http://localhost:3000",
      sessionId: "f00b8d1c",
      mode: "ask",
      transcriptMode: "chat",
      connectionState: "offline",
      connectionReason: null,
      columns: 30,
    });
    // The chip stays at minimum compact; identity collapses to fit.
    expect(layout.connectionVariant).toBe("compact");
  });

  test("online state shows no chip regardless of width", () => {
    const layout = layoutFooterLines({
      user: "alice@example.com",
      tenant: "acme",
      engineUrl: "http://localhost:3000",
      sessionId: "abcd1234",
      mode: "ask",
      transcriptMode: "chat",
      connectionState: "online",
      columns: 80,
    });
    expect(layout.connectionVariant).toBe("none");
  });

  test("identity + compact chip width never exceeds the available columns", () => {
    // Property-style: across a range of widths and reason lengths,
    // the picked layout should never push the rendered line past
    // the column budget. We approximate the rendered line as
    // identity + chip(compact|full).
    const reasons = [
      null,
      "Unable to connect",
      "Unable to connect. Is the computer able to reach localhost:3000?",
      "X".repeat(200),
    ];
    const widths = [40, 60, 80, 101, 140, 200];
    for (const columns of widths) {
      for (const reason of reasons) {
        const layout = layoutFooterLines({
          user: "alice@example.com",
          tenant: "acme",
          engineUrl: "http://localhost:3000",
          sessionId: "abcd1234",
          mode: "ask",
          transcriptMode: "chat",
          connectionState: "reconnecting",
          connectionReason: reason,
          columns,
        });
        const identityWidth =
          layout.identityPrefix.length +
          layout.identityHighlight.length +
          layout.identitySuffix.length;
        // Estimate chip width: compact = 17 chars (" · ⟳ reconnecting"),
        // full adds " · " + truncated reason capped at 38.
        const compact = 17;
        const full = compact + 3 + Math.min(reason?.length ?? 0, 38);
        const chipWidth = layout.connectionVariant === "full" ? full : compact;
        const safety = 2;
        expect(identityWidth + chipWidth).toBeLessThanOrEqual(Math.max(columns, 24) - safety + 1);
      }
    }
  });
});
