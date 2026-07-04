import { describe, expect, test } from "bun:test";
import { ThemeProvider } from "@chat-ui/index.ts";
import { EngineError, TransportError } from "@cli-core/errors.ts";
import { ErrorPanel, errorToPanel } from "../shell/ErrorPanel.tsx";
import { flush, renderInk } from "./helpers/ink.tsx";

describe("<ErrorPanel>", () => {
  test("rate-limit panel shows message + retry countdown", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ErrorPanel
          kind="rate-limit"
          payload={{
            message: "provider rate limit reached",
            retry_after: 12,
            hint: "wait or switch model",
            request_id: "trace-abc",
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const out = ui.text();
      expect(out).toContain("rate limit");
      expect(out).toContain("provider rate limit reached");
      expect(out).toContain("retry available in");
      expect(out).toContain("wait or switch model");
      expect(out).toContain("trace=trace-abc");
    } finally {
      ui.unmount();
    }
  });

  test("validation panel renders headlines + dim path rows + truncates after 8", async () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      path: `steps.${i}.kind`,
      message: `bad-${i}`,
    }));
    const ui = renderInk(
      <ThemeProvider>
        <ErrorPanel kind="validation" payload={{ errors, hint: "fix the schema" }} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const out = ui.text();
      expect(out).toContain("validation errors");
      expect(out).toContain("bad-0");
      expect(out).toContain("steps.0.kind");
      expect(out).toContain("(+4 more)");
      expect(out).toContain("fix the schema");
    } finally {
      ui.unmount();
    }
  });

  test("network panel falls back to default hint when none provided", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ErrorPanel kind="network" payload={{ message: "ECONNREFUSED 127.0.0.1:5050" }} />
      </ThemeProvider>,
    );
    try {
      await flush();
      const out = ui.text();
      expect(out).toContain("network error");
      expect(out).toContain("ECONNREFUSED");
      expect(out).toContain("check that the engine is reachable");
    } finally {
      ui.unmount();
    }
  });

  test("engine panel renders status + code + retry countdown", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ErrorPanel
          kind="engine"
          payload={{
            status: 503,
            code: "llm_provider_unavailable",
            message: "the LLM provider is overloaded",
            retry_after: 5,
            request_id: "trace-xyz",
          }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const out = ui.text();
      expect(out).toContain("HTTP 503");
      expect(out).toContain("llm_provider_unavailable");
      expect(out).toContain("retry available in");
      expect(out).toContain("trace=trace-xyz");
    } finally {
      ui.unmount();
    }
  });

  test("auth panel suggests re-login by default", async () => {
    const ui = renderInk(
      <ThemeProvider>
        <ErrorPanel
          kind="auth"
          payload={{ status: 401, message: "missing or invalid credentials" }}
        />
      </ThemeProvider>,
    );
    try {
      await flush();
      const out = ui.text();
      expect(out).toContain("HTTP 401");
      expect(out).toContain("missing or invalid credentials");
      expect(out).toContain("sk login");
    } finally {
      ui.unmount();
    }
  });
});

describe("errorToPanel routing", () => {
  test("maps EngineError 429 -> rate-limit kind", () => {
    const err = new EngineError(429, {
      code: "llm_provider_limited",
      message: "slow down",
      hint: "raise the quota",
      retry_after: 30,
      trace_id: "t-1",
    });
    const r = errorToPanel(err);
    expect(r.kind).toBe("rate-limit");
    expect((r.payload as { retry_after?: number }).retry_after).toBe(30);
  });

  test("maps EngineError 401 -> auth kind", () => {
    const err = new EngineError(401, { code: "unauthorized", message: "bad token" });
    const r = errorToPanel(err);
    expect(r.kind).toBe("auth");
    expect((r.payload as { status: number }).status).toBe(401);
  });

  test("maps EngineError 500 -> engine kind", () => {
    const err = new EngineError(500, { code: "internal_error", message: "boom" });
    const r = errorToPanel(err);
    expect(r.kind).toBe("engine");
  });

  test("maps TransportError -> network kind", () => {
    const r = errorToPanel(new TransportError(new Error("ECONNRESET")));
    expect(r.kind).toBe("network");
    expect((r.payload as { message: string }).message).toContain("ECONNRESET");
  });

  test("falls back to generic for unknown errors", () => {
    const r = errorToPanel(new Error("totally unknown"));
    expect(r.kind).toBe("generic");
  });
});
