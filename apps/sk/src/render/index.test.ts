// Dispatcher tests for renderIntent / renderSummary / renderTaskFailure.
// Three code paths: jsonMode (silent), non-TTY (plain ASCII), TTY (Ink mount).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyIntent } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  Phase,
  WorkflowIntent,
  WorkflowSummary,
} from "./types.ts";

// --- Fixtures ---

const wfIntent: WorkflowIntent = {
  name: "Daily Report",
  slug: "daily-report",
  trigger: { kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
  steps: [{ key: "fetch", kind: "request", connector_slug: "github" }],
};

const connIntent: ConnectorIntent = {
  template_slug: "stripe-api",
  name: "Stripe Prod",
  environment: "prod",
  auth_type: "api_key",
};

const ksIntent: KnowledgeSourceIntent = {
  file_path: "/docs/spec.pdf",
  title: "API Spec",
  mime_type: "application/pdf",
  size_bytes: 1024 * 512,
};

const wfSummary: WorkflowSummary = {
  id: "wf-abc",
  version: 2,
  name: "Daily Report",
  trigger: { kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
};

const connSummary: ConnectorSummary = {
  id: "con-xyz",
  slug: "stripe-prod",
  template_slug: "stripe-api",
  probe: { ok: true, status_code: 200, duration_ms: 88 },
};

const ksSummary: KnowledgeSourceSummary = {
  id: "ks-001",
  name: "API Spec",
  mime_type: "application/pdf",
  size_bytes: 1024 * 512,
};

const phases: ReadonlyArray<Phase> = [
  { name: "Validate", status: "succeeded" },
  { name: "Commit", status: "failed", detail: "duplicate slug" },
];

// --- Stderr capture helpers ---

let stderrBuf = "";
const origWrite = process.stderr.write.bind(process.stderr);
const origIsTTY = process.stderr.isTTY;

beforeEach(() => {
  stderrBuf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
});

// Helper to set isTTY
function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

// Lazy import so tests can control process.stderr.isTTY before the module
// resolves the code path on each call.
async function importDispatcher() {
  return import("./index.ts");
}

// ---- jsonMode: silent ----

describe("renderIntent · jsonMode", () => {
  test("workflow intent — nothing written to stderr", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(wfIntent as AnyIntent, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });

  test("connector intent — nothing written to stderr", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(connIntent as AnyIntent, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });

  test("knowledge source intent — nothing written to stderr", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(ksIntent as AnyIntent, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });
});

describe("renderSummary · jsonMode", () => {
  test("workflow summary — nothing written to stderr", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(wfSummary as AnySummary, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });

  test("connector summary — nothing written to stderr", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(connSummary as AnySummary, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });

  test("knowledge source summary — nothing written to stderr", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(ksSummary as AnySummary, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });
});

describe("renderTaskFailure · jsonMode", () => {
  test("phases — nothing written to stderr", async () => {
    setTTY(false);
    const { renderTaskFailure } = await importDispatcher();
    await renderTaskFailure(phases, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });
});

// ---- Non-TTY: plain ASCII ----

describe("renderIntent · non-TTY plain ASCII", () => {
  test("workflow intent emits bullet glyph and name", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(wfIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("Daily Report");
  });

  test("workflow intent emits trigger info", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(wfIntent as AnyIntent);
    expect(stderrBuf).toContain("schedule");
  });

  test("connector intent emits bullet glyph and template_slug", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(connIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("stripe-api");
  });

  test("knowledge source intent emits bullet glyph and title", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(ksIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("API Spec");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await expect(renderIntent(wfIntent as AnyIntent)).resolves.toBeUndefined();
  });
});

describe("renderSummary · non-TTY plain ASCII", () => {
  test("workflow summary emits checkmark glyph", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(wfSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("Daily Report");
    expect(stderrBuf).toContain("wf-abc");
  });

  test("connector summary emits checkmark and slug", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(connSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("stripe-prod");
  });

  test("knowledge source summary emits checkmark and name", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(ksSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("API Spec");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await expect(renderSummary(wfSummary as AnySummary)).resolves.toBeUndefined();
  });
});

describe("renderTaskFailure · non-TTY plain ASCII", () => {
  test("emits separator line and phase names", async () => {
    setTTY(false);
    const { renderTaskFailure } = await importDispatcher();
    await renderTaskFailure(phases);
    expect(stderrBuf).toContain("─");
    expect(stderrBuf).toContain("Validate");
    expect(stderrBuf).toContain("Commit");
  });

  test("emits the detail string for failed phase", async () => {
    setTTY(false);
    const { renderTaskFailure } = await importDispatcher();
    await renderTaskFailure(phases);
    expect(stderrBuf).toContain("duplicate slug");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderTaskFailure } = await importDispatcher();
    await expect(renderTaskFailure(phases)).resolves.toBeUndefined();
  });
});

// ---- jsonMode short-circuits before TTY detection ----

describe("jsonMode short-circuits before TTY detection", () => {
  test("jsonMode:true with isTTY:true still writes nothing", async () => {
    setTTY(true);
    const { renderIntent } = await importDispatcher();
    // jsonMode must return before touching isTTY or Ink
    await renderIntent(wfIntent as AnyIntent, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });

  test("jsonMode:true renderSummary with isTTY:true still writes nothing", async () => {
    setTTY(true);
    const { renderSummary } = await importDispatcher();
    await renderSummary(wfSummary as AnySummary, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });
});

// ---- TTY mount path ----
// Ink's render() + waitUntilExit() requires a real PTY to exit cleanly.
// In the bun test runner (no PTY), mountInk hangs indefinitely.
// These tests are skipped at the unit layer; the e2e layer (real terminal)
// covers the TTY Ink path end-to-end.
//
// We do verify the ttyAllowed() logic via the jsonMode guard test above:
// jsonMode:true + isTTY:true → still silent, confirming jsonMode is checked first.

describe("renderIntent · TTY mount path", () => {
  test.skip("workflow intent resolves and writes something [PTY required — skipped in unit layer]", async () => {
    setTTY(true);
    const { renderIntent } = await importDispatcher();
    await renderIntent(wfIntent as AnyIntent);
    expect(stderrBuf.length).toBeGreaterThan(0);
  });

  test.skip("connector intent resolves and writes something [PTY required — skipped in unit layer]", async () => {
    setTTY(true);
    const { renderIntent } = await importDispatcher();
    await renderIntent(connIntent as AnyIntent);
    expect(stderrBuf.length).toBeGreaterThan(0);
  });
});

describe("renderSummary · TTY mount path", () => {
  test.skip("workflow summary resolves and writes something [PTY required — skipped in unit layer]", async () => {
    setTTY(true);
    const { renderSummary } = await importDispatcher();
    await renderSummary(wfSummary as AnySummary);
    expect(stderrBuf.length).toBeGreaterThan(0);
  });
});

describe("renderTaskFailure · TTY mount path", () => {
  test.skip("phases resolves and writes something [PTY required — skipped in unit layer]", async () => {
    setTTY(true);
    const { renderTaskFailure } = await importDispatcher();
    await renderTaskFailure(phases);
    expect(stderrBuf.length).toBeGreaterThan(0);
  });
});
