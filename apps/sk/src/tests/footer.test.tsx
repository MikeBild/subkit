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

describe("Footer budget line — honest cost telemetry (Fix 7)", () => {
  function renderBudgetFooter(props: Partial<React.ComponentProps<typeof Footer>> = {}) {
    return render(
      <Footer
        user="alice@example.com"
        tenant="acme"
        engineUrl="https://subkit-api.example.dev"
        sessionId={null}
        mode="ask"
        transcriptMode="chat"
        sessionTokens={5_000_000}
        columns={120}
        {...props}
      />,
    );
  }

  test("renders ctx from the last call's prompt and turn from the cumulative total", () => {
    const instance = renderBudgetFooter({
      promptTokensLastCall: 90_000,
      turnTokensTotal: 3_900_000,
      contextCapTokens: 180_000,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("ctx 90k/180k");
    expect(frame).toContain("turn 3.9M");
    expect(frame).not.toContain("(50%)");
    instance.unmount();
    cleanup();
  });

  test("ctx percentage chip appears at the warning threshold", () => {
    const instance = renderBudgetFooter({
      promptTokensLastCall: 171_000,
      turnTokensTotal: 200_000,
      contextCapTokens: 180_000,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("ctx 171k/180k");
    expect(frame).toContain("(95%)");
    instance.unmount();
    cleanup();
  });

  test("ctx gauge hides when the last-call prompt size is unknown; turn figure stands alone", () => {
    const instance = renderBudgetFooter({
      promptTokensLastCall: null,
      turnTokensTotal: 12_500,
      contextCapTokens: 180_000,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).not.toContain("ctx ");
    expect(frame).toContain("turn 13k");
    instance.unmount();
    cleanup();
  });

  test("turn figure hides when the total is absent", () => {
    const instance = renderBudgetFooter({
      promptTokensLastCall: 10_000,
      turnTokensTotal: null,
      contextCapTokens: 180_000,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("ctx 10k/180k");
    expect(frame).not.toContain("turn ");
    instance.unmount();
    cleanup();
  });

  test("cache chip renders the per-turn hit-rate and cached-token count", () => {
    const instance = renderBudgetFooter({
      turnTokensTotal: 200_000,
      cacheReadPct: 85.5,
      cacheReadTokens: 120_000,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("cache 85.5%");
    expect(frame).toContain("(120k)");
    instance.unmount();
    cleanup();
  });

  test("cache chip hides when the engine sent no cache figure", () => {
    const instance = renderBudgetFooter({
      turnTokensTotal: 200_000,
      cacheReadPct: null,
    });
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).not.toContain("cache ");
    instance.unmount();
    cleanup();
  });
});

describe("Footer connection chip layout", () => {
  test("long reconnect reason at moderate width falls back to compact chip", () => {
    const layout = layoutFooterLines({
      user: "user@example.com",
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
    expect(layout.identityPrefix).toContain("@ default");
    expect(layout.identityPrefix).toContain("· localhost:3000");
  });

  test("wide terminal keeps the full chip with reason", () => {
    const layout = layoutFooterLines({
      user: "user@example.com",
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
      user: "user@example.com",
      tenant: "default",
      engineUrl: "http://localhost:3000",
      sessionId: "f00b8d1c",
      mode: "ask",
      transcriptMode: "chat",
      connectionState: "offline",
      connectionReason: null,
      columns: 30,
    });
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
        const compact = 17;
        const full = compact + 3 + Math.min(reason?.length ?? 0, 38);
        const chipWidth = layout.connectionVariant === "full" ? full : compact;
        const safety = 2;
        expect(identityWidth + chipWidth).toBeLessThanOrEqual(Math.max(columns, 24) - safety + 1);
      }
    }
  });
});
