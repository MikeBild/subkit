import { describe, expect, test } from "bun:test";
import { buildWorkflowUsageFromParts } from "../usage-guidance.ts";

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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow step URL literals use ${input.*} syntax
    const stepUrl = "https://api.example.com/?d=${input.date}&fmt=${input.format}";
    const usage = buildWorkflowUsageFromParts({
      workflow: {
        id: "wf-004",
        slug: "fetch-by-date",
        name: "Fetch By Date",
        definition: {
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

    expect(usage.inputs.length).toBeGreaterThanOrEqual(2);
    const names = usage.inputs.map((i) => i.name);
    expect(names).toContain("date");
    expect(names).toContain("format");
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
