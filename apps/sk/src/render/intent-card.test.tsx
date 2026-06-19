import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { humanBytes } from "./helpers.ts";
import { IntentCard } from "./intent-card.tsx";
import type { ConnectorIntent, KnowledgeSourceIntent, WorkflowIntent } from "./types.ts";

function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderIntent(intent: WorkflowIntent | ConnectorIntent | KnowledgeSourceIntent) {
  return render((<IntentCard intent={intent} />) as ReactElement);
}

// --- humanBytes unit tests ---
describe("humanBytes", () => {
  test("formats bytes", () => expect(humanBytes(512)).toBe("512B"));
  test("formats kilobytes", () => expect(humanBytes(1024)).toBe("1KB"));
  test("formats megabytes with one decimal for small values", () =>
    expect(humanBytes(1.5 * 1024 * 1024)).toBe("1.5MB"));
  test("formats large megabytes without decimal", () =>
    expect(humanBytes(10 * 1024 * 1024)).toBe("10MB"));
  test("formats gigabytes", () => expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe("2GB"));
  test("returns raw string for negative", () => expect(humanBytes(-1)).toBe("-1B"));
  test("returns raw string for NaN", () => expect(humanBytes(NaN)).toBe("NaNB"));
});

// --- WorkflowIntent ---
describe("IntentCard · workflow", () => {
  const base: WorkflowIntent = {
    kind: "workflow",
    name: "Nightly Sync",
    slug: "nightly-sync",
    trigger: { kind: "schedule", cron: "0 0 * * *", tz: "UTC" },
    steps: [],
  };

  test("schedule trigger shows cron and tz", () => {
    const ui = renderIntent(base);
    const out = snapshot(ui);
    expect(out).toContain("Create workflow Nightly Sync (nightly-sync)");
    expect(out).toContain("schedule cron=0 0 * * * tz=UTC");
    ui.unmount();
  });

  test("webhook trigger shows source and events", () => {
    const intent: WorkflowIntent = {
      kind: "workflow",
      name: "PR Notifier",
      trigger: { kind: "webhook", source: "github", events: ["push", "pull_request"] },
      steps: [],
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("Create workflow PR Notifier");
    expect(out).toContain("webhook source=github events=push,pull_request");
    ui.unmount();
  });

  test("webhook trigger with no events shows wildcard", () => {
    const intent: WorkflowIntent = {
      kind: "workflow",
      name: "Any Event",
      trigger: { kind: "webhook", source: "stripe", events: [] },
      steps: [],
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("events=*");
    ui.unmount();
  });

  test("request trigger shows 'request'", () => {
    const intent: WorkflowIntent = {
      kind: "workflow",
      name: "On Demand",
      trigger: { kind: "request" },
      steps: [],
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("request");
    ui.unmount();
  });

  test("0 steps renders without step list", () => {
    const ui = renderIntent(base);
    const out = snapshot(ui);
    expect(out).toContain("Create workflow");
    // No step-list content expected — just no crash
    ui.unmount();
  });

  test("1 step shows step key and kind", () => {
    const intent: WorkflowIntent = {
      ...base,
      steps: [{ key: "fetch_data", kind: "request" }],
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("fetch_data");
    ui.unmount();
  });

  test("3 steps with connector_slug show all step keys", () => {
    const intent: WorkflowIntent = {
      ...base,
      steps: [
        { key: "fetch", kind: "request", connector_slug: "github" },
        { key: "transform", kind: "transform" },
        { key: "notify", kind: "request", connector_slug: "slack" },
      ],
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("fetch");
    expect(out).toContain("transform");
    expect(out).toContain("notify");
    ui.unmount();
  });

  test("no slug omits parenthetical in heading", () => {
    const { slug: _omit, ...baseWithoutSlug } = base;
    const intent: WorkflowIntent = baseWithoutSlug as WorkflowIntent;
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("Create workflow Nightly Sync");
    expect(out).not.toContain("(nightly-sync)");
    ui.unmount();
  });
});

// --- ConnectorIntent ---
describe("IntentCard · connector", () => {
  const base: ConnectorIntent = { kind: "connector", template_slug: "stripe-api" };

  test("minimal connector shows template_slug", () => {
    const ui = renderIntent(base);
    const out = snapshot(ui);
    expect(out).toContain("Create connector stripe-api");
    expect(out).toContain("Template: stripe-api");
    ui.unmount();
  });

  test("full connector shows name, environment, auth, base_url", () => {
    const intent: ConnectorIntent = {
      kind: "connector",
      template_slug: "stripe-api",
      name: "Stripe Prod",
      environment: "prod",
      auth_type: "api_key",
      base_url: "https://api.stripe.com",
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("Create connector Stripe Prod (stripe-api)");
    expect(out).toContain("Environment: prod");
    expect(out).toContain("Auth: api_key");
    expect(out).toContain("Base URL: https://api.stripe.com");
    ui.unmount();
  });

  test("optional fields absent when not provided", () => {
    const ui = renderIntent(base);
    const out = snapshot(ui);
    expect(out).not.toContain("Environment:");
    expect(out).not.toContain("Auth:");
    expect(out).not.toContain("Base URL:");
    ui.unmount();
  });
});

// --- KnowledgeSourceIntent ---
describe("IntentCard · knowledge source", () => {
  test("shows basename, human-readable size, and mime type", () => {
    const intent: KnowledgeSourceIntent = {
      kind: "knowledge_source",
      file_path: "/home/user/docs/spec.pdf",
      title: "API Spec",
      mime_type: "application/pdf",
      size_bytes: 2.5 * 1024 * 1024,
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("Create knowledge source API Spec");
    // basename — not the full path
    expect(out).toContain("spec.pdf");
    expect(out).not.toContain("/home/user/docs/");
    expect(out).toContain("2.5MB");
    expect(out).toContain("application/pdf");
    ui.unmount();
  });

  test("sub-1KB file shows bytes", () => {
    const intent: KnowledgeSourceIntent = {
      kind: "knowledge_source",
      file_path: "/tmp/tiny.txt",
      title: "Tiny",
      mime_type: "text/plain",
      size_bytes: 512,
    };
    const ui = renderIntent(intent);
    const out = snapshot(ui);
    expect(out).toContain("512B");
    ui.unmount();
  });
});
