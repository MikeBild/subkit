// Dispatcher tests for renderIntent / renderSummary / renderTaskList.
// Three code paths: jsonMode (silent), non-TTY (plain ASCII), TTY (Ink mount).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlanStep } from "../repl/plan-cell.tsx";
import type { AnyIntent } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  WorkflowIntent,
  WorkflowSummary,
} from "./types.ts";

// --- Fixtures ---

const wfIntent: WorkflowIntent = {
  kind: "workflow",
  name: "Daily Report",
  slug: "daily-report",
  trigger: { kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
  steps: [{ key: "fetch", kind: "request", connector_slug: "github" }],
};

const connIntent: ConnectorIntent = {
  kind: "connector",
  template_slug: "stripe-api",
  name: "Stripe Prod",
  environment: "prod",
  auth_type: "api_key",
  base_url: "https://api.stripe.com",
};

const ksIntent: KnowledgeSourceIntent = {
  kind: "knowledge_source",
  file_path: "/docs/spec.pdf",
  title: "API Spec",
  mime_type: "application/pdf",
  size_bytes: 1024 * 512,
};

const wfSummary: WorkflowSummary = {
  kind: "workflow",
  id: "wf-abc",
  version: 2,
  name: "Daily Report",
  trigger: { kind: "schedule", cron: "0 9 * * *", tz: "UTC" },
  preview_execution_id: "exec-preview-1",
};

const connSummary: ConnectorSummary = {
  kind: "connector",
  id: "con-xyz",
  slug: "stripe-prod",
  template_slug: "stripe-api",
  probe: { ok: true, status_code: 200, duration_ms: 88 },
};

const ksSummary: KnowledgeSourceSummary = {
  kind: "knowledge_source",
  id: "ks-001",
  name: "API Spec",
  mime_type: "application/pdf",
  size_bytes: 1024 * 512,
  file_id: "fid-001",
};

const phases: ReadonlyArray<PlanStep> = [
  { id: "validate", label: "Validate", status: "succeeded" },
  { id: "commit", label: "Commit", status: "failed", detail: "duplicate slug" },
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

describe("renderTaskList · jsonMode", () => {
  test("phases — nothing written to stderr", async () => {
    setTTY(false);
    const { renderTaskList } = await importDispatcher();
    await renderTaskList(phases, { jsonMode: true });
    expect(stderrBuf).toBe("");
  });
});

// ---- Non-TTY: plain ASCII ----

// Each non-TTY plain-output test asserts that EVERY field of the fixture
// appears in the rendered output. Without this, a new optional field added
// to an Ink card but forgotten in the plain renderer would silently slip
// through CI.
describe("renderIntent · non-TTY plain ASCII", () => {
  test("workflow intent emits every fixture field", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(wfIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("Daily Report");
    expect(stderrBuf).toContain("daily-report");
    expect(stderrBuf).toContain("schedule");
    expect(stderrBuf).toContain("0 9 * * *");
    expect(stderrBuf).toContain("UTC");
    expect(stderrBuf).toContain("fetch");
    expect(stderrBuf).toContain("request");
    expect(stderrBuf).toContain("github");
  });

  test("connector intent emits every fixture field", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(connIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("Stripe Prod");
    expect(stderrBuf).toContain("stripe-api");
    expect(stderrBuf).toContain("prod");
    expect(stderrBuf).toContain("api_key");
    expect(stderrBuf).toContain("https://api.stripe.com");
  });

  test("knowledge source intent emits every fixture field", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(ksIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("API Spec");
    // basename of file_path
    expect(stderrBuf).toContain("spec.pdf");
    expect(stderrBuf).toContain("application/pdf");
    // human-readable size for 512 KiB
    expect(stderrBuf).toContain("512KB");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await expect(renderIntent(wfIntent as AnyIntent)).resolves.toBeUndefined();
  });
});

describe("renderSummary · non-TTY plain ASCII", () => {
  test("workflow summary emits every fixture field", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(wfSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("Daily Report");
    expect(stderrBuf).toContain("wf-abc");
    expect(stderrBuf).toContain("version=2");
    expect(stderrBuf).toContain("schedule");
    expect(stderrBuf).toContain("0 9 * * *");
    expect(stderrBuf).toContain("UTC");
    expect(stderrBuf).toContain("exec-preview-1");
    // Next-action hints use 'sk' prefix
    expect(stderrBuf).toContain("sk workflows run wf-abc");
    expect(stderrBuf).toContain("sk workflows get wf-abc");
    expect(stderrBuf).toContain("sk workflows history wf-abc");
  });

  test("connector summary emits every fixture field", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(connSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("stripe-prod");
    expect(stderrBuf).toContain("con-xyz");
    expect(stderrBuf).toContain("template=stripe-api");
    expect(stderrBuf).toContain("probe: ok");
    expect(stderrBuf).toContain("status=200");
    expect(stderrBuf).toContain("88ms");
    expect(stderrBuf).toContain("sk connectors get con-xyz");
    expect(stderrBuf).toContain("sk connectors probe con-xyz");
  });

  test("knowledge source summary emits every fixture field", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary(ksSummary as AnySummary);
    expect(stderrBuf).toContain("✓");
    expect(stderrBuf).toContain("API Spec");
    expect(stderrBuf).toContain("ks-001");
    expect(stderrBuf).toContain("application/pdf");
    expect(stderrBuf).toContain("512KB");
    expect(stderrBuf).toContain("file=fid-001");
    expect(stderrBuf).toContain("sk knowledge-sources get ks-001");
    expect(stderrBuf).toContain("sk knowledge-sources search");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await expect(renderSummary(wfSummary as AnySummary)).resolves.toBeUndefined();
  });
});

describe("renderTaskList · non-TTY plain ASCII", () => {
  test("emits separator line and phase names", async () => {
    setTTY(false);
    const { renderTaskList } = await importDispatcher();
    await renderTaskList(phases);
    expect(stderrBuf).toContain("─");
    expect(stderrBuf).toContain("Validate");
    expect(stderrBuf).toContain("Commit");
  });

  test("emits the detail string for failed phase", async () => {
    setTTY(false);
    const { renderTaskList } = await importDispatcher();
    await renderTaskList(phases);
    expect(stderrBuf).toContain("duplicate slug");
  });

  test("returns a resolved promise", async () => {
    setTTY(false);
    const { renderTaskList } = await importDispatcher();
    await expect(renderTaskList(phases)).resolves.toBeUndefined();
  });

  test("warning-but-proceed phase mix renders warning glyph and detail", async () => {
    setTTY(false);
    const { renderTaskList } = await importDispatcher();
    const mix: ReadonlyArray<PlanStep> = [
      { id: "validate", label: "Validate", status: "succeeded" },
      {
        id: "preview",
        label: "Preview",
        status: "warning",
        detail: "2 warning(s): rate_limited, partial_match",
      },
      { id: "save", label: "Save", status: "pending" },
    ];
    await renderTaskList(mix);
    expect(stderrBuf).toContain("Preview");
    expect(stderrBuf).toContain("2 warning(s)");
    expect(stderrBuf).toContain("rate_limited");
    expect(stderrBuf).toContain("partial_match");
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

// The TTY mount path uses Ink's render() + waitUntilExit(), which needs a
// real PTY to exit. The bun test runner has no PTY, so that path is verified
// at the e2e layer (real terminal) rather than here. ttyAllowed() is still
// covered: the jsonMode tests above run with isTTY=true to confirm jsonMode
// short-circuits before TTY detection.
