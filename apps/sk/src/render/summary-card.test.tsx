import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { SummaryCard } from "./summary-card.tsx";
import type { ConnectorSummary, KnowledgeSourceSummary, WorkflowSummary } from "./types.ts";

function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderSummary(summary: WorkflowSummary | ConnectorSummary | KnowledgeSourceSummary) {
  return render((<SummaryCard summary={summary} />) as ReactElement);
}

// --- WorkflowSummary ---
describe("SummaryCard · workflow", () => {
  const base: WorkflowSummary = {
    id: "wf-001",
    version: 1,
    name: "Nightly Sync",
    trigger: { kind: "schedule", cron: "0 0 * * *", tz: "UTC" },
  };

  test("shows name, id, and version on success", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain('Created workflow "Nightly Sync"');
    expect(out).toContain("id=wf-001");
    expect(out).toContain("version=1");
    ui.unmount();
  });

  test("schedule trigger renders cron and tz", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain("schedule cron=0 0 * * * tz=UTC");
    ui.unmount();
  });

  test("webhook trigger renders source and events", () => {
    const summary: WorkflowSummary = {
      ...base,
      trigger: { kind: "webhook", source: "github", events: ["push"] },
    };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("webhook source=github events=push");
    ui.unmount();
  });

  test("request trigger renders 'request'", () => {
    const summary: WorkflowSummary = { ...base, trigger: { kind: "request" } };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("request");
    ui.unmount();
  });

  test("shows preview_execution_id when present", () => {
    const summary: WorkflowSummary = { ...base, preview_execution_id: "exec-abc" };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("preview execution: exec-abc");
    ui.unmount();
  });

  test("no preview_execution_id when absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("preview execution");
    ui.unmount();
  });

  test("Next: hints use 'sk' prefix — not 'subkit'", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain("sk workflows run wf-001");
    expect(out).toContain("sk workflows get wf-001");
    expect(out).toContain("sk workflows history wf-001");
    expect(out).not.toContain("subkit workflows");
    ui.unmount();
  });
});

// --- ConnectorSummary ---
describe("SummaryCard · connector", () => {
  const base: ConnectorSummary = {
    id: "con-001",
    slug: "stripe-prod",
    template_slug: "stripe-api",
  };

  test("shows slug, id, and template", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain('Created connector "stripe-prod"');
    expect(out).toContain("id=con-001");
    expect(out).toContain("template=stripe-api");
    ui.unmount();
  });

  test("probe ok=true renders 'ok'", () => {
    const summary: ConnectorSummary = {
      ...base,
      probe: { ok: true, status_code: 200, duration_ms: 142 },
    };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("probe: ok");
    expect(out).toContain("status=200");
    expect(out).toContain("142ms");
    ui.unmount();
  });

  test("probe ok=false renders 'FAILED'", () => {
    const summary: ConnectorSummary = {
      ...base,
      probe: { ok: false, status_code: 401 },
    };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("probe: FAILED");
    expect(out).toContain("status=401");
    ui.unmount();
  });

  test("probe without status_code or duration_ms omits those fields", () => {
    const summary: ConnectorSummary = { ...base, probe: { ok: true } };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("probe: ok");
    expect(out).not.toContain("status=");
    expect(out).not.toContain("ms");
    ui.unmount();
  });

  test("no probe block when probe is absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("probe:");
    ui.unmount();
  });

  test("Next: hints use 'sk' prefix — not 'subkit'", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain("sk connectors get con-001");
    expect(out).toContain("sk connectors probe con-001");
    expect(out).not.toContain("subkit connectors");
    ui.unmount();
  });
});

// --- KnowledgeSourceSummary ---
describe("SummaryCard · knowledge source", () => {
  const base: KnowledgeSourceSummary = {
    id: "ks-001",
    name: "API Spec",
    mime_type: "application/pdf",
    size_bytes: 1024 * 1024,
  };

  test("shows name and id", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain('Created knowledge source "API Spec"');
    expect(out).toContain("id=ks-001");
    ui.unmount();
  });

  test("shows mime type and human-readable size", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain("application/pdf");
    expect(out).toContain("1MB");
    ui.unmount();
  });

  test("shows file_id when present", () => {
    const summary: KnowledgeSourceSummary = { ...base, file_id: "fid-xyz" };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("file=fid-xyz");
    ui.unmount();
  });

  test("no file_id when absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("file=");
    ui.unmount();
  });

  test("link_failed shows warning", () => {
    const summary: KnowledgeSourceSummary = { ...base, link_failed: true };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain("file link did not persist");
    ui.unmount();
  });

  test("no link_failed warning when flag is absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("file link");
    ui.unmount();
  });

  test("Next: hints use 'sk' prefix — not 'subkit'", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).toContain("sk knowledge-sources get ks-001");
    expect(out).toContain("sk knowledge-sources search");
    expect(out).not.toContain("subkit knowledge");
    ui.unmount();
  });
});
