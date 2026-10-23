import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnyIntent } from "./intent-card.tsx";
import type { AnySummary } from "./summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceIntent,
  KnowledgeSourceSummary,
  PlanStep,
  WorkflowIntent,
  WorkflowSummary,
} from "./types.ts";

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

const fileAuthoredConnIntent: ConnectorIntent = {
  kind: "connector",
  name: "Loop MCP",
  base_url: "https://mcp.example.com/mcp",
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
  usage: {
    inputs: [{ name: "date", type: "string", required: true }],
    output: "raw result of the last step `report` (request)",
    access: [
      { via: "cli", label: "sk CLI", command: "sk workflows run daily-report date=<value>" },
      { via: "mcp", label: "MCP tool", tool: "wf_daily-report" },
    ],
    follow_up: "Run it now, show the REST/HTTP call, or set up a schedule?",
  },
};

const connSummary: ConnectorSummary = {
  kind: "connector",
  id: "con-xyz",
  slug: "stripe-prod",
  template_slug: "stripe-api",
  probe: { ok: true, status_code: 200, duration_ms: 88 },
  usage: {
    inputs: [],
    output: null,
    access: [{ via: "cli", label: "sk CLI", command: "sk connectors get con-xyz" }],
    follow_up: "What should this connector do? I can start a workflow draft from a goal.",
  },
};

const ksSummary: KnowledgeSourceSummary = {
  kind: "knowledge_source",
  id: "ks-001",
  name: "API Spec",
  mime_type: "application/pdf",
  size_bytes: 1024 * 512,
  file_id: "fid-001",
  usage: {
    inputs: [],
    output: "8 searchable chunks",
    access: [{ via: "cli", label: "sk CLI", command: 'sk knowledge-sources search "<query>"' }],
    follow_up: "Try a search against it?",
  },
};

const phases: ReadonlyArray<PlanStep> = [
  { id: "validate", label: "Validate", status: "succeeded" },
  { id: "commit", label: "Commit", status: "failed", detail: "duplicate slug" },
];

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

function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

async function importDispatcher() {
  return import("./index.ts");
}

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

  test("connector intent without a template names no template and no undefined", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(fileAuthoredConnIntent as AnyIntent);
    expect(stderrBuf).toContain("Create connector Loop MCP");
    expect(stderrBuf).not.toContain("undefined");
    expect(stderrBuf).not.toContain("Template:");
  });

  test("connector intent with neither name nor template stays readable", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent({ kind: "connector" } as AnyIntent);
    expect(stderrBuf).toContain("Create connector");
    expect(stderrBuf).not.toContain("undefined");
  });

  test("connector update intent says Update", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent({
      kind: "connector",
      action: "Update",
      name: "Search Console",
    } as AnyIntent);
    expect(stderrBuf).toContain("Update connector Search Console");
    expect(stderrBuf).not.toContain("Create connector");
  });

  test("knowledge source intent emits every fixture field", async () => {
    setTTY(false);
    const { renderIntent } = await importDispatcher();
    await renderIntent(ksIntent as AnyIntent);
    expect(stderrBuf).toContain("●");
    expect(stderrBuf).toContain("API Spec");
    expect(stderrBuf).toContain("spec.pdf");
    expect(stderrBuf).toContain("application/pdf");
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
    expect(stderrBuf).toContain("inputs: date (required)");
    expect(stderrBuf).toContain("Use it via:");
    expect(stderrBuf).toContain("sk workflows run daily-report");
    expect(stderrBuf).toContain("wf_daily-report");
    expect(stderrBuf).toContain("Run it now, show the REST/HTTP call, or set up a schedule?");
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
    expect(stderrBuf).toContain("Use it via:");
    expect(stderrBuf).toContain("sk connectors get con-xyz");
    expect(stderrBuf).toContain("What should this connector do?");
  });

  test("connector summary without a template drops the template segment", async () => {
    setTTY(false);
    const { renderSummary } = await importDispatcher();
    await renderSummary({
      kind: "connector",
      id: "con-file",
      slug: "loop-mcp",
      probe: { ok: true },
    } as AnySummary);
    expect(stderrBuf).toContain('Created connector "loop-mcp" · id=con-file');
    expect(stderrBuf).not.toContain("template=");
    expect(stderrBuf).not.toContain("undefined");
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
    expect(stderrBuf).toContain("output: 8 searchable chunks");
    expect(stderrBuf).toContain("sk knowledge-sources search");
    expect(stderrBuf).toContain("Try a search against it?");
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

describe("jsonMode short-circuits before TTY detection", () => {
  test("jsonMode:true with isTTY:true still writes nothing", async () => {
    setTTY(true);
    const { renderIntent } = await importDispatcher();
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
