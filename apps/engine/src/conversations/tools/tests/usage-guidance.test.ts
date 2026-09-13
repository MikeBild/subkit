// Unit tests for usage-guidance.ts pure builders.
//
// What's covered:
//   - inputs from declared `definition.input_schema` (properties + required flags)
//   - inputs synthesized from `${input.x}` placeholders when no input_schema
//   - output: "shaped by the workflow's output transform" when output_transform set
//   - output: last-step line when no output_transform
//   - access entries: always cli/mcp/chat/rest; rest has `url` only with publicBaseUrl
//   - live unpaused schedule rows → `via:"schedule"` entries with cron+tz in detail
//   - no live schedule → single hint entry with create_schedule command
//   - paused schedule rows are excluded from live schedules
//   - webhook entries only when inboundHooks non-empty; url only with publicBaseUrl
//   - follow_up values for workflow, connector, knowledge_source

import { describe, expect, test } from "bun:test";

import {
  buildConnectorUsage,
  buildKnowledgeSourceUsage,
  buildWorkflowUsageFromParts,
} from "../usage-guidance.ts";

// ── buildWorkflowUsageFromParts ─────────────────────────────────────────────

describe("buildWorkflowUsageFromParts — inputs from input_schema", () => {
  test("extracts inputs from declared input_schema properties + required array", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-001",
        slug: "daily-report",
        name: "Daily Report",
        definition: {
          input_schema: {
            type: "object",
            properties: {
              date: { type: "string" },
              format: { type: "string" },
              limit: { type: "number" },
            },
            required: ["date"],
          },
          steps: [{ id: "step1", kind: "transform", expression: "$" }],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.inputs).toHaveLength(3);
    const dateInput = usage.inputs.find((i) => i.name === "date");
    expect(dateInput).toMatchObject({ name: "date", type: "string", required: true });
    const formatInput = usage.inputs.find((i) => i.name === "format");
    expect(formatInput).toMatchObject({ name: "format", type: "string", required: false });
    const limitInput = usage.inputs.find((i) => i.name === "limit");
    expect(limitInput).toMatchObject({ name: "limit", type: "number", required: false });
  });

  test("no inputs when input_schema has no properties", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-002",
        slug: "no-inputs",
        name: "No Inputs",
        definition: {
          input_schema: { type: "object", properties: {} },
          steps: [{ id: "step1", kind: "transform", expression: "42" }],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.inputs).toHaveLength(0);
  });

  test("all inputs are optional when required array is absent", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-003",
        slug: "optional-all",
        name: "Optional All",
        definition: {
          input_schema: {
            type: "object",
            properties: { foo: { type: "string" }, bar: { type: "boolean" } },
          },
          steps: [],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.inputs.every((i) => i.required === false)).toBe(true);
  });
});

describe("buildWorkflowUsageFromParts — inputs synthesized from placeholders", () => {
  test("synthesizes inputs from placeholder references in a request step URL", () => {
    // synthesizeInputSchema collects from request step url.
    // The URL contains ${input.date} and ${input.format} placeholder syntax
    // (workflow substitution, not JS template literals — hence the raw string).
    // eslint-disable-next-line no-template-curly-in-string -- workflow step URL literals use ${input.*} syntax
    const stepUrl = "https://api.example.com/?d=${input.date}&fmt=${input.format}";
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-004",
        slug: "fetch-by-date",
        name: "Fetch By Date",
        definition: {
          // no explicit input_schema — inputs are synthesized from placeholders
          steps: [
            {
              id: "fetch",
              kind: "request",
              method: "GET",
              url: stepUrl,
            },
          ],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    // synthesizeInputSchema yields all string type, none required
    expect(usage.inputs.length).toBeGreaterThanOrEqual(2);
    const names = usage.inputs.map((i) => i.name);
    expect(names).toContain("date");
    expect(names).toContain("format");
    // synthesized inputs have type "string"
    for (const inp of usage.inputs) {
      expect(inp.type).toBe("string");
    }
  });

  test("no inputs when no input references and no input_schema", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-005",
        slug: "static",
        name: "Static",
        definition: {
          steps: [
            {
              id: "fetch",
              kind: "request",
              method: "GET",
              url: "https://api.example.com/static",
            },
          ],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.inputs).toHaveLength(0);
  });
});

describe("buildWorkflowUsageFromParts — output", () => {
  test("output is 'shaped by the workflow's output transform' when output_transform is set", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-006",
        slug: "transformed",
        name: "Transformed",
        definition: {
          output_transform: "$.result",
          steps: [{ id: "step1", kind: "transform", expression: "$" }],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.output).toBe("shaped by the workflow's output transform");
  });

  test("output describes the last step when no output_transform", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-007",
        slug: "raw-output",
        name: "Raw Output",
        definition: {
          steps: [
            { id: "first", kind: "request", method: "GET", url: "https://example.com" },
            { id: "last-step", kind: "transform", expression: "$" },
          ],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.output).toContain("last-step");
    expect(usage.output).toContain("transform");
  });

  test("output is null when steps is empty and no output_transform", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-008",
        slug: "empty-steps",
        name: "Empty Steps",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.output).toBeNull();
  });
});

describe("buildWorkflowUsageFromParts — access entries (static)", () => {
  test("always includes cli, mcp, chat, and rest entries", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-009",
        slug: "my-wf",
        name: "My WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const vias = usage.access.map((a) => a.via);
    expect(vias).toContain("cli");
    expect(vias).toContain("mcp");
    expect(vias).toContain("chat");
    expect(vias).toContain("rest");
  });

  test("rest entry has no url when publicBaseUrl is null", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-010",
        slug: "my-wf",
        name: "My WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const rest = usage.access.find((a) => a.via === "rest");
    expect(rest).toBeDefined();
    expect(rest?.url).toBeUndefined();
    expect(rest?.command).toBe("POST /v1/executions");
    expect(rest?.detail).toContain('"source":"saved"');
    expect(rest?.detail).toContain('"workflow_id":"wf-010"');
  });

  test("rest entry has absolute url when publicBaseUrl is set", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-011",
        slug: "my-wf",
        name: "My WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: "https://engine.example.com",
    });

    const rest = usage.access.find((a) => a.via === "rest");
    expect(rest?.url).toBe("https://engine.example.com/v1/executions");
    expect(rest?.command).toBe("POST https://engine.example.com/v1/executions");
  });

  test("rest body includes input placeholders for declared inputs", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-011b",
        slug: "with-inputs",
        name: "With Inputs",
        definition: {
          input_schema: {
            type: "object",
            required: ["ticket_key"],
            properties: {
              ticket_key: { type: "string" },
              include_history: { type: "boolean" },
            },
          },
          steps: [],
        },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: "https://engine.example.com",
    });

    const rest = usage.access.find((a) => a.via === "rest");
    expect(rest?.detail).toContain('"input":{"ticket_key":"<ticket_key>","include_history":null}');
  });

  test("mcp entry carries the correct tool name", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-012",
        slug: "my-wf",
        name: "My WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const mcp = usage.access.find((a) => a.via === "mcp");
    expect(mcp?.tool).toBe("wf_my-wf");
  });
});

describe("buildWorkflowUsageFromParts — schedule access entries", () => {
  test("live (unpaused) schedules produce one schedule entry each with cron+tz in detail", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-013",
        slug: "scheduled-wf",
        name: "Scheduled WF",
        definition: { steps: [] },
      },
      schedules: [
        { cron: "0 9 * * 1-5", timezone: "Europe/Berlin", paused: false },
        { cron: "0 18 * * 5", timezone: "UTC", paused: false },
      ],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const scheduleEntries = usage.access.filter((a) => a.via === "schedule");
    expect(scheduleEntries).toHaveLength(2);
    const berlin = scheduleEntries.find((e) => e.detail?.includes("Europe/Berlin"));
    expect(berlin).toBeDefined();
    expect(berlin?.detail).toContain("0 9 * * 1-5");
    const utc = scheduleEntries.find((e) => e.detail?.includes("UTC"));
    expect(utc?.detail).toContain("0 18 * * 5");
  });

  test("paused schedules are excluded; hint entry shows create_schedule command", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-014",
        slug: "paused-wf",
        name: "Paused WF",
        definition: { steps: [] },
      },
      schedules: [{ cron: "0 9 * * *", timezone: "UTC", paused: true }],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const scheduleEntries = usage.access.filter((a) => a.via === "schedule");
    // The paused schedule counts as "no live schedule" → one hint entry
    expect(scheduleEntries).toHaveLength(1);
    expect(scheduleEntries[0]?.command).toContain("create_schedule");
  });

  test("no schedules at all → single create_schedule hint entry", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-015",
        slug: "no-schedule-wf",
        name: "No Schedule WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const scheduleEntries = usage.access.filter((a) => a.via === "schedule");
    expect(scheduleEntries).toHaveLength(1);
    expect(scheduleEntries[0]?.command).toContain("create_schedule");
  });

  test("mix of paused and live schedules shows only live ones", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-016",
        slug: "mixed-wf",
        name: "Mixed WF",
        definition: { steps: [] },
      },
      schedules: [
        { cron: "0 9 * * *", timezone: "UTC", paused: true },
        { cron: "0 18 * * *", timezone: "UTC", paused: false },
      ],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    const scheduleEntries = usage.access.filter((a) => a.via === "schedule");
    // One live entry (no create_schedule hint)
    expect(scheduleEntries).toHaveLength(1);
    expect(scheduleEntries[0]?.detail).toContain("0 18 * * *");
    expect(scheduleEntries[0]?.command).toBeUndefined();
  });
});

describe("buildWorkflowUsageFromParts — webhook access entries", () => {
  test("no webhook entries when inboundHooks is empty", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: { id: "wf-017", slug: "no-hooks", name: "No Hooks", definition: { steps: [] } },
      schedules: [],
      inboundHooks: [],
      publicBaseUrl: null,
    });

    expect(usage.access.filter((a) => a.via === "webhook")).toHaveLength(0);
  });

  test("one webhook entry per hook; url only when publicBaseUrl is set", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-018",
        slug: "hooks-wf",
        name: "Hooks WF",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [{ slug: "hook-abc" }, { slug: "hook-def" }],
      publicBaseUrl: "https://engine.example.com",
    });

    const webhooks = usage.access.filter((a) => a.via === "webhook");
    expect(webhooks).toHaveLength(2);
    const abc = webhooks.find((w) => w.url?.includes("hook-abc"));
    expect(abc?.url).toBe("https://engine.example.com/v1/hooks/hook-abc");
  });

  test("webhook entry has no url when publicBaseUrl is null", () => {
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-019",
        slug: "hooks-no-origin",
        name: "Hooks No Origin",
        definition: { steps: [] },
      },
      schedules: [],
      inboundHooks: [{ slug: "hook-xyz" }],
      publicBaseUrl: null,
    });

    const webhook = usage.access.find((a) => a.via === "webhook");
    expect(webhook).toBeDefined();
    expect(webhook?.url).toBeUndefined();
    expect(webhook?.command).toContain("/v1/hooks/hook-xyz");
  });
});

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

// ── follow_up_options ───────────────────────────────────────────────────────

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
    // No duplicate values
    expect(new Set(values).size).toBe(values.length);
    // Must include the four primary access vias
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

// ── buildConnectorUsage ─────────────────────────────────────────────────────

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

// ── buildKnowledgeSourceUsage ───────────────────────────────────────────────

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

    // The scope-detail string for workflow scope references the workflow id
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
