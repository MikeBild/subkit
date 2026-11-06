import { describe, expect, test } from "bun:test";
import {
  buildConnectorUsage,
  buildKnowledgeSourceUsage,
  buildWorkflowUsageFromParts,
} from "../usage-guidance.ts";

describe("buildWorkflowUsageFromParts — identity + follow_up", () => {
  test("kind is 'workflow' and follow_up offers run, REST, and schedule options", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-020",
        slug: "the-wf",
        name: "The WF",
        definition: { description: "A test workflow", steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.kind).toBe("workflow");
    expect(usage.follow_up).toBe("Run it now, show the REST/HTTP call, or set up a schedule?");
    expect(usage.summary).toBe("A test workflow");
    expect(usage.slug).toBe("the-wf");
    expect(usage.name).toBe("The WF");
  });
});

describe("buildWorkflowUsageFromParts — follow_up_options", () => {
  test("follow_up_options is present and non-empty for workflow usage", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-021",
        slug: "picker-wf",
        name: "Picker WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.follow_up_options).toBeDefined();
    expect(Array.isArray(usage.follow_up_options)).toBe(true);
    expect((usage.follow_up_options ?? []).length).toBeGreaterThan(0);
  });

  test("follow_up_options entries each have label, value, and optional detail", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-022",
        slug: "shape-wf",
        name: "Shape WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    for (const opt of usage.follow_up_options ?? []) {
      expect(typeof opt.label).toBe("string");
      expect(typeof opt.value).toBe("string");
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.value.length).toBeGreaterThan(0);
      if (opt.detail !== undefined) {
        expect(typeof opt.detail).toBe("string");
      }
    }
  });

  test("follow_up_options values are derived from access entry vias (no duplicates)", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-023",
        slug: "dedup-wf",
        name: "Dedup WF",
        definition: { steps: [] },
      },
      schedules: [
        { cron: "0 9 * * 1-5", timezone: "UTC", paused: false },
        { cron: "0 18 * * 5", timezone: "UTC", paused: false },
      ],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const values = (usage.follow_up_options ?? []).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("cli");
    expect(values).toContain("mcp");
    expect(values).toContain("chat");
    expect(values).toContain("rest");
    expect(values).toContain("schedule");
  });

  test("follow_up_options excludes webhook entries", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-024",
        slug: "hook-opts-wf",
        name: "Hook Opts WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [{ slug: "hook-abc" }],
      publicBaseUrl: "https://engine.example.com",
    });

    const values = (usage.follow_up_options ?? []).map((o) => o.value);
    expect(values).not.toContain("webhook");
  });

  test("mcp option detail is the wf_<slug> tool name", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-025",
        slug: "mcp-opts-wf",
        name: "MCP Opts WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const mcpOpt = (usage.follow_up_options ?? []).find((o) => o.value === "mcp");
    expect(mcpOpt).toBeDefined();
    expect(mcpOpt?.detail).toBe("wf_mcp-opts-wf");
  });

  test("rest option detail contains the POST command", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-026",
        slug: "rest-opts-wf",
        name: "REST Opts WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: "https://engine.example.com",
    });

    const restOpt = (usage.follow_up_options ?? []).find((o) => o.value === "rest");
    expect(restOpt).toBeDefined();
    expect(restOpt?.detail).toContain("POST");
    expect(restOpt?.detail).toContain("/v1/executions");
  });

  test("chat option detail contains /subkit run <slug>", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-027",
        slug: "chat-opts-wf",
        name: "Chat Opts WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const chatOpt = (usage.follow_up_options ?? []).find((o) => o.value === "chat");
    expect(chatOpt).toBeDefined();
    expect(chatOpt?.detail).toContain("/subkit run");
    expect(chatOpt?.detail).toContain("chat-opts-wf");
  });

  test("schedule hint option detail contains create_schedule when no live schedule", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-028",
        slug: "sched-opts-wf",
        name: "Sched Opts WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const schedOpt = (usage.follow_up_options ?? []).find((o) => o.value === "schedule");
    expect(schedOpt).toBeDefined();
    expect(schedOpt?.detail).toContain("create_schedule");
  });
});

describe("buildConnectorUsage", () => {
  test("returns kind=connector with expected fields", () => {
    const usage = buildConnectorUsage({
      id: "conn-001",
      slug: "my-connector",
      display_name: "My Connector",
      driver: "http",
      environment: "prod",
    });

    expect(usage.kind).toBe("connector");
    expect(usage.slug).toBe("my-connector");
    expect(usage.name).toBe("My Connector");
    expect(usage.summary).toBe("http connector (prod)");
    expect(usage.inputs).toHaveLength(0);
    expect(usage.output).toBeNull();
  });

  test("follow_up is a non-empty string", () => {
    const usage = buildConnectorUsage({
      id: "conn-002",
      slug: "c",
      display_name: "C",
      driver: "postgres",
      environment: "dev",
    });

    expect(usage.follow_up.length).toBeGreaterThan(0);
  });

  test("access entries include cli and chat entries", () => {
    const usage = buildConnectorUsage({
      id: "conn-003",
      slug: "c",
      display_name: "C",
      driver: "http",
      environment: "dev",
    });

    const vias = usage.access.map((a) => a.via);
    expect(vias).toContain("cli");
    expect(vias).toContain("chat");
  });
});

describe("buildKnowledgeSourceUsage", () => {
  test("returns kind=knowledge_source with expected fields", () => {
    const usage = buildKnowledgeSourceUsage({
      id: "ks-001",
      slug: "api-docs",
      name: "API Docs",
      description: "API documentation for v2",
      scope: "tenant",
      chunk_count: 42,
    });

    expect(usage.kind).toBe("knowledge_source");
    expect(usage.slug).toBe("api-docs");
    expect(usage.name).toBe("API Docs");
    expect(usage.summary).toBe("API documentation for v2");
    expect(usage.inputs).toHaveLength(0);
    expect(usage.output).toContain("42");
  });

  test("follow_up ends with a question mark", () => {
    const usage = buildKnowledgeSourceUsage({
      id: "ks-002",
      slug: "ks",
      name: "KS",
      description: null,
      scope: "tenant",
      chunk_count: 0,
    });

    expect(usage.follow_up.endsWith("?")).toBe(true);
  });

  test("scope='workflow' surfaces workflow_id in detail", () => {
    const usage = buildKnowledgeSourceUsage({
      id: "ks-003",
      slug: "workflow-docs",
      name: "Workflow Docs",
      description: null,
      scope: "workflow",
      chunk_count: 5,
      workflow_id: "wf-abc",
    });

    const chatEntry = usage.access.find((a) => a.via === "chat");
    expect(chatEntry?.detail).toContain("wf-abc");
  });

  test("singular chunk count uses correct grammar", () => {
    const usage = buildKnowledgeSourceUsage({
      id: "ks-004",
      slug: "single",
      name: "Single",
      description: null,
      scope: "tenant",
      chunk_count: 1,
    });

    expect(usage.output).toBe("1 searchable chunk");
  });

  test("plural chunk count uses correct grammar", () => {
    const usage = buildKnowledgeSourceUsage({
      id: "ks-005",
      slug: "plural",
      name: "Plural",
      description: null,
      scope: "tenant",
      chunk_count: 7,
    });

    expect(usage.output).toBe("7 searchable chunks");
  });
});
