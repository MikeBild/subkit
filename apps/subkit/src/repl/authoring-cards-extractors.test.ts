import { describe, expect, test } from "bun:test";
import type { ToolCallState } from "@cli-core/index.ts";
import {
  extractConnectorIntent,
  extractConnectorSummary,
  extractKnowledgeSourceSummary,
  extractWorkflowIntent,
  extractWorkflowSummary,
} from "./authoring-cards.tsx";

function makeCall(overrides: Partial<ToolCallState> & { name: string }): ToolCallState {
  return {
    id: "tc-test",
    args: {},
    status: "done",
    result: undefined,
    ...overrides,
  };
}

function withResult(name: string, data: unknown): ToolCallState {
  return makeCall({ name, result: { ok: true, data } });
}

describe("extractWorkflowIntent", () => {
  const validWorkflowData = {
    workflow: {
      name: "Nightly Sync",
      slug: "nightly-sync",
      definition: {
        trigger: { kind: "schedule", cron: "0 0 * * *", tz: "UTC" },
        steps: [
          { key: "fetch_data", kind: "request", connector_slug: "github" },
          { key: "notify", kind: "request" },
        ],
      },
    },
  };

  test("valid payload returns WorkflowIntent with name, slug, trigger, steps", () => {
    const call = withResult("edit_workflow_patch", validWorkflowData);
    const result = extractWorkflowIntent(call);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("workflow");
    expect(result?.name).toBe("Nightly Sync");
    expect(result?.slug).toBe("nightly-sync");
    expect(result?.trigger).toMatchObject({ kind: "schedule", cron: "0 0 * * *", tz: "UTC" });
    expect(result?.steps).toHaveLength(2);
    expect(result?.steps[0]).toMatchObject({
      key: "fetch_data",
      kind: "request",
      connector_slug: "github",
    });
    expect(result?.steps[1]).toMatchObject({ key: "notify", kind: "request" });
  });

  test("steps without connector_slug do not include that field", () => {
    const call = withResult("edit_workflow_patch", validWorkflowData);
    const result = extractWorkflowIntent(call);
    expect(result?.steps[1]).not.toHaveProperty("connector_slug");
  });

  test("webhook trigger is extracted correctly", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        name: "PR Handler",
        definition: {
          trigger: { kind: "webhook", source: "github", events: ["push", "pr"] },
          steps: [{ key: "step1", kind: "request" }],
        },
      },
    });
    const result = extractWorkflowIntent(call);
    expect(result?.trigger).toMatchObject({
      kind: "webhook",
      source: "github",
      events: ["push", "pr"],
    });
  });

  test("request trigger (no events or cron) falls back to {kind: 'request'}", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        name: "On Demand",
        definition: {
          trigger: { kind: "request" },
          steps: [{ key: "step1", kind: "transform" }],
        },
      },
    });
    const result = extractWorkflowIntent(call);
    expect(result?.trigger).toEqual({ kind: "request" });
  });

  test("steps can live at top-level workflow.steps (no definition wrapper)", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        name: "Flat Steps",
        steps: [{ key: "s1", kind: "request" }],
      },
    });
    const result = extractWorkflowIntent(call);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Flat Steps");
    expect(result?.steps).toHaveLength(1);
  });

  test("missing steps → returns null", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: { name: "No Steps", definition: { trigger: { kind: "request" } } },
    });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("missing name → returns null", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        definition: {
          trigger: { kind: "request" },
          steps: [{ key: "s1", kind: "request" }],
        },
      },
    });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("result is null → returns null", () => {
    const call = makeCall({ name: "edit_workflow_patch", result: null });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("result.data is null → returns null", () => {
    const call = makeCall({ name: "edit_workflow_patch", result: { ok: true, data: null } });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("result.data is a string → returns null", () => {
    const call = makeCall({
      name: "edit_workflow_patch",
      result: { ok: true, data: "unexpected" },
    });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("steps array contains non-objects → they are filtered out", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        name: "Mixed Steps",
        definition: {
          trigger: { kind: "request" },
          steps: [null, { key: "s1", kind: "request" }, 42],
        },
      },
    });
    const result = extractWorkflowIntent(call);
    expect(result).not.toBeNull();
    expect(result?.steps).toHaveLength(1);
  });

  test("name is a number → returns null", () => {
    const call = withResult("edit_workflow_patch", {
      workflow: {
        name: 123,
        definition: {
          trigger: { kind: "request" },
          steps: [{ key: "s1", kind: "request" }],
        },
      },
    });
    expect(extractWorkflowIntent(call)).toBeNull();
  });

  test("status: 'error' — still extracts if result data is valid", () => {
    const call: ToolCallState = {
      id: "tc-err",
      name: "edit_workflow_patch",
      args: {},
      status: "failed",
      result: { ok: false, data: validWorkflowData },
    };
    const result = extractWorkflowIntent(call);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Nightly Sync");
  });
});

describe("extractConnectorIntent", () => {
  const validConnectorData = {
    connector: {
      name: "Stripe Prod",
      template_slug: "stripe-api",
      environment: "prod",
      auth_type: "api_key",
      base_url: "https://api.stripe.com",
    },
  };

  test("valid payload returns ConnectorIntent with all fields", () => {
    const call = withResult("start_connector_from_template", validConnectorData);
    const result = extractConnectorIntent(call);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("connector");
    expect(result?.template_slug).toBe("stripe-api");
    expect(result?.name).toBe("Stripe Prod");
    expect(result?.environment).toBe("prod");
    expect(result?.auth_type).toBe("api_key");
    expect(result?.base_url).toBe("https://api.stripe.com");
  });

  test("minimal payload — only template_slug — returns ConnectorIntent", () => {
    const call = withResult("start_connector_from_description", {
      connector: { template_slug: "github-api" },
    });
    const result = extractConnectorIntent(call);
    expect(result).not.toBeNull();
    expect(result?.template_slug).toBe("github-api");
    expect(result?.name).toBeUndefined();
    expect(result?.environment).toBeUndefined();
  });

  test("template_slug at top-level data is used when not inside connector", () => {
    const call = withResult("start_connector_from_description", {
      template_slug: "slack-api",
    });
    const result = extractConnectorIntent(call);
    expect(result).not.toBeNull();
    expect(result?.template_slug).toBe("slack-api");
  });

  test("environment 'dev' is accepted", () => {
    const call = withResult("start_connector_from_template", {
      connector: { template_slug: "stripe-api", environment: "dev" },
    });
    const result = extractConnectorIntent(call);
    expect(result?.environment).toBe("dev");
  });

  test("environment with unknown value is omitted", () => {
    const call = withResult("start_connector_from_template", {
      connector: { template_slug: "stripe-api", environment: "staging" },
    });
    const result = extractConnectorIntent(call);
    expect(result?.environment).toBeUndefined();
  });

  test("missing template_slug → returns null", () => {
    const call = withResult("start_connector_from_template", {
      connector: { name: "No Template" },
    });
    expect(extractConnectorIntent(call)).toBeNull();
  });

  test("result.data is null → returns null", () => {
    const call = makeCall({
      name: "start_connector_from_template",
      result: { ok: true, data: null },
    });
    expect(extractConnectorIntent(call)).toBeNull();
  });

  test("result is undefined → returns null", () => {
    const call = makeCall({ name: "start_connector_from_template" });
    expect(extractConnectorIntent(call)).toBeNull();
  });

  test("template_slug is a number → returns null", () => {
    const call = withResult("start_connector_from_template", {
      connector: { template_slug: 99 },
    });
    expect(extractConnectorIntent(call)).toBeNull();
  });

  test("data is an array → returns null", () => {
    const call = makeCall({
      name: "start_connector_from_template",
      result: { ok: true, data: [] },
    });
    expect(extractConnectorIntent(call)).toBeNull();
  });
});

describe("extractWorkflowSummary", () => {
  const validSummaryData = {
    workflow_id: "wf-001",
    name: "Nightly Sync",
    version: 3,
    workflow: {
      name: "Nightly Sync",
      version: 3,
      definition: {
        trigger: { kind: "schedule", cron: "0 0 * * *", tz: "UTC" },
      },
    },
  };

  test("valid payload returns WorkflowSummary with id, name, version, trigger", () => {
    const call = withResult("save_workflow_draft", validSummaryData);
    const result = extractWorkflowSummary(call);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("workflow");
    expect(result?.id).toBe("wf-001");
    expect(result?.name).toBe("Nightly Sync");
    expect(result?.version).toBe(3);
    expect(result?.trigger).toMatchObject({ kind: "schedule" });
  });

  test("name falls back to top-level d.name when workflow.name is missing", () => {
    const call = withResult("save_workflow_draft", {
      workflow_id: "wf-002",
      name: "Fallback Name",
      version: 1,
    });
    const result = extractWorkflowSummary(call);
    expect(result?.name).toBe("Fallback Name");
  });

  test("version falls back to workflow.version when d.version is absent", () => {
    const call = withResult("save_workflow_draft", {
      workflow_id: "wf-003",
      workflow: { name: "From Workflow", version: 5, definition: {} },
    });
    const result = extractWorkflowSummary(call);
    expect(result?.version).toBe(5);
    expect(result?.name).toBe("From Workflow");
  });

  test("missing workflow_id → returns null", () => {
    const call = withResult("save_workflow_draft", { name: "No ID", version: 1 });
    expect(extractWorkflowSummary(call)).toBeNull();
  });

  test("missing name → returns null", () => {
    const call = withResult("save_workflow_draft", { workflow_id: "wf-004", version: 1 });
    expect(extractWorkflowSummary(call)).toBeNull();
  });

  test("version is null → returns null", () => {
    const call = withResult("save_workflow_draft", {
      workflow_id: "wf-005",
      name: "No Version",
    });
    expect(extractWorkflowSummary(call)).toBeNull();
  });

  test("result.data is null → returns null", () => {
    const call = makeCall({ name: "save_workflow_draft", result: { ok: true, data: null } });
    expect(extractWorkflowSummary(call)).toBeNull();
  });

  test("result is undefined → returns null", () => {
    const call = makeCall({ name: "save_workflow_draft" });
    expect(extractWorkflowSummary(call)).toBeNull();
  });

  test("workflow_id is a number → returns null", () => {
    const call = withResult("save_workflow_draft", {
      workflow_id: 42,
      name: "Typed Wrong",
      version: 1,
    });
    expect(extractWorkflowSummary(call)).toBeNull();
  });
});

describe("extractConnectorSummary", () => {
  const validConnSummaryData = {
    connector: {
      id: "con-001",
      slug: "stripe-prod",
      template_slug: "stripe-api",
    },
  };

  test("valid payload returns ConnectorSummary with id, slug, template_slug", () => {
    const call = withResult("save_connector_draft", validConnSummaryData);
    const result = extractConnectorSummary(call);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("connector");
    expect(result?.id).toBe("con-001");
    expect(result?.slug).toBe("stripe-prod");
    expect(result?.template_slug).toBe("stripe-api");
  });

  test("connector key missing (data is flat) → returns null", () => {
    const call = withResult("save_connector_draft", {
      id: "con-002",
      slug: "flat-slug",
      template_slug: "flat-template",
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("connector.id missing → returns null", () => {
    const call = withResult("save_connector_draft", {
      connector: { slug: "stripe-prod", template_slug: "stripe-api" },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("connector.slug missing → returns null", () => {
    const call = withResult("save_connector_draft", {
      connector: { id: "con-003", template_slug: "stripe-api" },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("connector.template_slug missing → returns null", () => {
    const call = withResult("save_connector_draft", {
      connector: { id: "con-004", slug: "stripe-prod" },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("result.data is null → returns null", () => {
    const call = makeCall({ name: "save_connector_draft", result: { ok: true, data: null } });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("result is undefined → returns null", () => {
    const call = makeCall({ name: "save_connector_draft" });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("connector.id is a number → returns null", () => {
    const call = withResult("save_connector_draft", {
      connector: { id: 99, slug: "s", template_slug: "t" },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("connector.slug is a number → returns null", () => {
    const call = withResult("save_connector_draft", {
      connector: { id: "con-005", slug: 0, template_slug: "stripe-api" },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });

  test("data is an array → returns null", () => {
    const call = makeCall({
      name: "save_connector_draft",
      result: { ok: true, data: [{ connector: {} }] },
    });
    expect(extractConnectorSummary(call)).toBeNull();
  });
});

describe("extractKnowledgeSourceSummary", () => {
  const validKsData = {
    created: true,
    knowledge_source: {
      id: "ks-001",
      name: "OCPP 2.0.1 Protocol Reference",
      slug: "ocpp-2-0-1-protocol-reference",
      scope: "global",
      status: "ready",
      chunk_count: 42,
      bytes_total: 123456,
    },
    audit_log_id: "audit-001",
  };

  test("valid payload + inline args returns KnowledgeSourceSummary with mime from args", () => {
    const call: ToolCallState = {
      id: "tc-ks",
      name: "create_knowledge_source",
      args: { mode: "inline", name: "X", content: "y", mime_type: "text/markdown" },
      status: "done",
      result: { ok: true, data: validKsData },
    };
    const result = extractKnowledgeSourceSummary(call);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("knowledge_source");
    expect(result?.id).toBe("ks-001");
    expect(result?.name).toBe("OCPP 2.0.1 Protocol Reference");
    expect(result?.mime_type).toBe("text/markdown");
    expect(result?.size_bytes).toBe(123456);
    expect(result?.file_id).toBeUndefined();
  });

  test("from_attachment args adds file_id and falls back to octet-stream mime", () => {
    const call: ToolCallState = {
      id: "tc-ks-att",
      name: "create_knowledge_source",
      args: { mode: "from_attachment", file_id: "fid_abc-123" },
      status: "done",
      result: { ok: true, data: validKsData },
    };
    const result = extractKnowledgeSourceSummary(call);
    expect(result?.file_id).toBe("fid_abc-123");
    expect(result?.mime_type).toBe("application/octet-stream");
  });

  test("inline mode without explicit mime_type falls back to text/markdown", () => {
    const call: ToolCallState = {
      id: "tc-ks-inline-default",
      name: "create_knowledge_source",
      args: { mode: "inline", name: "X", content: "y" },
      status: "done",
      result: { ok: true, data: validKsData },
    };
    const result = extractKnowledgeSourceSummary(call);
    expect(result?.mime_type).toBe("text/markdown");
  });

  test("missing knowledge_source key → returns null", () => {
    const call = withResult("create_knowledge_source", { created: true });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });

  test("knowledge_source missing id → returns null", () => {
    const call = withResult("create_knowledge_source", {
      knowledge_source: { name: "X", bytes_total: 0 },
    });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });

  test("knowledge_source missing name → returns null", () => {
    const call = withResult("create_knowledge_source", {
      knowledge_source: { id: "ks-x", bytes_total: 0 },
    });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });

  test("bytes_total absent → size_bytes defaults to 0", () => {
    const call = withResult("create_knowledge_source", {
      knowledge_source: { id: "ks-no-bytes", name: "n" },
    });
    const result = extractKnowledgeSourceSummary(call);
    expect(result?.size_bytes).toBe(0);
  });

  test("bytes_total is a string → defaults to 0", () => {
    const call = withResult("create_knowledge_source", {
      knowledge_source: { id: "ks-bad-bytes", name: "n", bytes_total: "lots" },
    });
    const result = extractKnowledgeSourceSummary(call);
    expect(result?.size_bytes).toBe(0);
  });

  test("result.data is null → returns null", () => {
    const call = makeCall({
      name: "create_knowledge_source",
      result: { ok: true, data: null },
    });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });

  test("result is undefined → returns null", () => {
    const call = makeCall({ name: "create_knowledge_source" });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });

  test("id is a number → returns null", () => {
    const call = withResult("create_knowledge_source", {
      knowledge_source: { id: 7, name: "n", bytes_total: 1 },
    });
    expect(extractKnowledgeSourceSummary(call)).toBeNull();
  });
});
