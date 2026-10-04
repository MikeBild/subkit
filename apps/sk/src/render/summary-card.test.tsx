import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { SummaryCard } from "./summary-card.tsx";
import type {
  ConnectorSummary,
  KnowledgeSourceSummary,
  ResourceUsage,
  WorkflowSummary,
} from "./types.ts";

const workflowUsage: ResourceUsage = {
  inputs: [
    { name: "city", type: "string", required: true },
    { name: "limit", type: "number", required: false },
  ],
  output: "shaped by the workflow's output transform",
  access: [
    { via: "cli", label: "sk CLI", command: "sk workflows run nightly-sync city=<value>" },
    { via: "mcp", label: "MCP tool", tool: "wf_nightly-sync" },
    { via: "chat", label: "Chat", command: "/subkit run nightly-sync" },
    {
      via: "rest",
      label: "REST API",
      command: "POST /v1/executions",
      detail: 'body: {"source":"saved","workflow_id":"wf-001"}',
    },
    { via: "schedule", label: "Schedule (live)", detail: "0 0 * * * (UTC)" },
  ],
  follow_up: "Run it now, show the REST/HTTP call, or set up a schedule?",
};

const workflowUsageWithOptions: ResourceUsage = {
  ...workflowUsage,
  follow_up_options: [
    { label: "sk CLI", value: "cli", detail: "sk workflows run nightly-sync" },
    { label: "MCP tool", value: "mcp", detail: "wf_nightly-sync" },
    { label: "Chat", value: "chat", detail: "/subkit run nightly-sync" },
    { label: "REST API", value: "rest", detail: "POST /v1/executions" },
    { label: "Schedule (live)", value: "schedule", detail: "0 0 * * * (UTC)" },
  ],
};

function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderSummary(summary: WorkflowSummary | ConnectorSummary | KnowledgeSourceSummary) {
  return render((<SummaryCard summary={summary} />) as ReactElement);
}

describe("SummaryCard · workflow", () => {
  const base: WorkflowSummary = {
    kind: "workflow",
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

  test("usage block renders inputs, output, access entries, and follow-up", () => {
    const ui = renderSummary({ ...base, usage: workflowUsage });
    const out = snapshot(ui);
    expect(out).toContain("inputs: city (required), limit");
    expect(out).toContain("output: shaped by the workflow's output transform");
    expect(out).toContain("Use it via:");
    expect(out).toContain("sk workflows run nightly-sync");
    expect(out).toContain("wf_nightly-sync");
    expect(out).toContain("/subkit run nightly-sync");
    expect(out).toContain("POST /v1/executions");
    expect(out).toContain("0 0 * * * (UTC)");
    expect(out).toContain("Run it now, show the REST/HTTP call, or set up a schedule?");
    ui.unmount();
  });

  test("no usage block when usage is absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("Use it via:");
    ui.unmount();
  });

  test("follow_up_options renders as numbered choice list when present", () => {
    const ui = renderSummary({ ...base, usage: workflowUsageWithOptions });
    const out = snapshot(ui);
    expect(out).toContain("1. sk CLI");
    expect(out).toContain("2. MCP tool");
    expect(out).toContain("3. Chat");
    expect(out).toContain("4. REST API");
    expect(out).toContain("5. Schedule (live)");
    expect(out).toContain("wf_nightly-sync");
    expect(out).toContain("POST /v1/executions");
    expect(out).not.toContain("Run it now, show the REST/HTTP call, or set up a schedule?");
    ui.unmount();
  });

  test("plain follow_up text renders when follow_up_options is absent", () => {
    const ui = renderSummary({ ...base, usage: workflowUsage });
    const out = snapshot(ui);
    expect(out).toContain("Run it now, show the REST/HTTP call, or set up a schedule?");
    expect(out).not.toContain("1. sk CLI");
    ui.unmount();
  });
});

describe("SummaryCard · connector", () => {
  const base: ConnectorSummary = {
    kind: "connector",
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

  test("file-authored connector renders no template segment", () => {
    const summary: ConnectorSummary = { kind: "connector", id: "con-file", slug: "loop-mcp" };
    const ui = renderSummary(summary);
    const out = snapshot(ui);
    expect(out).toContain('Created connector "loop-mcp"');
    expect(out).toContain("id=con-file");
    expect(out).not.toContain("template=");
    expect(out).not.toContain("undefined");
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

  test("usage block renders access entries and follow-up", () => {
    const usage: ResourceUsage = {
      inputs: [],
      output: null,
      access: [
        {
          via: "cli",
          label: "sk CLI",
          command: "sk connectors get con-001",
          detail: "probe health with: sk connectors probe con-001",
        },
        {
          via: "chat",
          label: "Workflows",
          detail: 'request steps reference it as connector: "stripe-prod"',
        },
      ],
      follow_up: "What should this connector do? I can start a workflow draft from a goal.",
    };
    const ui = renderSummary({ ...base, usage });
    const out = snapshot(ui);
    expect(out).toContain("Use it via:");
    expect(out).toContain("sk connectors get con-001");
    expect(out).toContain('connector: "stripe-prod"');
    expect(out).toContain("What should this connector do?");
    expect(out).not.toContain("subkit connectors");
    ui.unmount();
  });

  test("no usage block when usage is absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("Use it via:");
    ui.unmount();
  });
});

describe("SummaryCard · knowledge source", () => {
  const base: KnowledgeSourceSummary = {
    kind: "knowledge_source",
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

  test("usage block renders access entries and follow-up", () => {
    const usage: ResourceUsage = {
      inputs: [],
      output: "12 searchable chunks",
      access: [
        {
          via: "chat",
          label: "Chat / authoring",
          command: 'search_knowledge("<query>")',
          detail: "tenant-wide — available to every conversation and workflow authoring session",
        },
        { via: "cli", label: "sk CLI", command: 'sk knowledge-sources search "<query>"' },
      ],
      follow_up: "Try a search against it?",
    };
    const ui = renderSummary({ ...base, usage });
    const out = snapshot(ui);
    expect(out).toContain("output: 12 searchable chunks");
    expect(out).toContain("Use it via:");
    expect(out).toContain("sk knowledge-sources search");
    expect(out).toContain("Try a search against it?");
    expect(out).not.toContain("subkit knowledge");
    ui.unmount();
  });

  test("no usage block when usage is absent", () => {
    const ui = renderSummary(base);
    const out = snapshot(ui);
    expect(out).not.toContain("Use it via:");
    ui.unmount();
  });
});
