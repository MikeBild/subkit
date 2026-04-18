// Unit tests for the two-line footer. We render the Footer in
// isolation (no InkApp) and assert on stable substrings.

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type React from "react";
import { compressCwd, engineHost, Footer, MODE_LABELS } from "../repl/footer.tsx";

function renderFooter(props: Partial<React.ComponentProps<typeof Footer>> = {}) {
  // `??` would clobber explicit `null`, which we need to test — use
  // `in` so tests can pass `tenant: null` and keep it null.
  const tenant = "tenant" in props ? (props.tenant ?? null) : "acme";
  const sessionId = "sessionId" in props ? (props.sessionId ?? null) : null;
  return render(
    <Footer
      user={props.user ?? "alice@example.com"}
      tenant={tenant}
      engineUrl={props.engineUrl ?? "https://subkit-api.example.dev"}
      sessionId={sessionId}
      mode={props.mode ?? "ask"}
    />,
  );
}

describe("compressCwd", () => {
  test("replaces the home prefix with `~`", () => {
    expect(compressCwd("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
  });

  test("returns `~` when the cwd is exactly $HOME", () => {
    expect(compressCwd("/Users/me", "/Users/me")).toBe("~");
  });

  test("returns the raw path when not under $HOME", () => {
    expect(compressCwd("/tmp/foo", "/Users/me")).toBe("/tmp/foo");
  });

  test("no-ops when home is missing", () => {
    expect(compressCwd("/tmp/foo", "")).toBe("/tmp/foo");
  });
});

describe("engineHost", () => {
  test("strips scheme and path", () => {
    expect(engineHost("https://subkit-api.example.dev/v1")).toBe("subkit-api.example.dev");
  });

  test("keeps explicit port", () => {
    expect(engineHost("http://localhost:8080")).toBe("localhost:8080");
  });

  test("falls back to raw input when not a URL", () => {
    expect(engineHost("not a url")).toBe("not a url");
  });
});

describe("Footer — line 1 (subkit identity)", () => {
  test("renders user @ tenant · engine-host", () => {
    const instance = renderFooter({
      user: "alice@example.com",
      tenant: "acme",
      engineUrl: "https://subkit-api.example.dev",
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("alice@example.com");
    expect(frame).toContain("@ acme");
    expect(frame).toContain("subkit-api.example.dev");
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

  test("shows short session id when one is set", () => {
    const instance = renderFooter({ sessionId: "abcd1234-0000-0000-0000-000000000000" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("session abcd1234");
    instance.unmount();
    cleanup();
  });

  test("shows `session new` when sessionId is null", () => {
    const instance = renderFooter({ sessionId: null });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("session new");
    instance.unmount();
    cleanup();
  });

  test("engine url port is preserved", () => {
    const instance = renderFooter({ engineUrl: "http://localhost:8080" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("localhost:8080");
    instance.unmount();
    cleanup();
  });
});

describe("Footer — line 2 (mode + cycle hint)", () => {
  test("ask mode shows `ask approval` and the cycle hint", () => {
    const instance = renderFooter({ mode: "ask" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain(MODE_LABELS.ask);
    expect(frame).toContain("shift+tab to cycle");
    instance.unmount();
    cleanup();
  });

  test("auto mode shows `auto-approve on`", () => {
    const instance = renderFooter({ mode: "auto" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain(MODE_LABELS.auto);
    expect(frame).not.toContain(MODE_LABELS.ask);
    instance.unmount();
    cleanup();
  });

  test("plan mode shows `plan mode (read-only)`", () => {
    const instance = renderFooter({ mode: "plan" });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain(MODE_LABELS.plan);
    expect(frame).not.toContain(MODE_LABELS.auto);
    instance.unmount();
    cleanup();
  });

  test("cycle hint is always on line 2", () => {
    for (const m of ["ask", "auto", "plan"] as const) {
      const instance = renderFooter({ mode: m });
      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("shift+tab to cycle");
      instance.unmount();
      cleanup();
    }
  });
});

describe("Footer — subkit-native labeling", () => {
  test("labels are subkit-native, not Claude-Code branded", () => {
    expect(MODE_LABELS.ask).not.toMatch(/claude/i);
    expect(MODE_LABELS.auto).not.toMatch(/bypass permissions/i);
    expect(MODE_LABELS.plan).toContain("read-only");
  });

  test("footer does NOT surface cwd or model — those belong to IDE agents", () => {
    const instance = renderFooter({
      user: "x@y.z",
      tenant: "t",
      engineUrl: "https://engine.example/",
      sessionId: null,
      mode: "ask",
    });
    const frame = instance.lastFrame() ?? "";
    // Should not leak an absolute filesystem path or a model identifier.
    expect(frame).not.toMatch(/\/Users\//);
    expect(frame).not.toMatch(/claude-|gpt-|sonnet-/i);
    instance.unmount();
    cleanup();
  });
});
