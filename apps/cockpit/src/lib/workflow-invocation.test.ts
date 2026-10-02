import { describe, expect, test } from "bun:test";
import { CATALOGS } from "@/lib/i18n";
import {
  HOOK_STATE_KEYS,
  hasFixedInput,
  type InvocationHook,
  type InvocationSchedule,
  initialInvocationMode,
  invocationModes,
  isWorkflowInvocation,
  SCHEDULE_STATE_KEYS,
  verifierName,
} from "@/lib/workflow-invocation";

const hook: InvocationHook = {
  slug: "orders",
  path: "/v1/hooks/orders",
  url: null,
  verifier: "standard",
  signed: true,
  signing_headers: [],
  hmac: null,
  state: "active",
  environment: "prod",
};
const schedule: InvocationSchedule = {
  cron: "0 7 * * *",
  timezone: "UTC",
  environment: "prod",
  input: null,
  state: "active",
  next_fire_at: null,
};

describe("isWorkflowInvocation", () => {
  const answer = {
    http: { path: "/v1/executions", body: {} },
    mcp: {},
    cli: {},
    input: { sample: {} },
    output: {},
    authority: {},
    webhook_input_shape: {},
  };

  test("an answer with the parts the page reads is one", () => {
    expect(isWorkflowInvocation(answer)).toBe(true);
  });

  test("a 200 that carries something else is a failed read", () => {
    expect(isWorkflowInvocation({ items: [], total: 0 })).toBe(false);
    expect(isWorkflowInvocation(null)).toBe(false);
    expect(isWorkflowInvocation([])).toBe(false);
    expect(isWorkflowInvocation({ ...answer, http: { path: "/v1/executions" } })).toBe(false);
    expect(isWorkflowInvocation({ ...answer, input: {} })).toBe(false);
  });
});

describe("invocationModes", () => {
  test("a request, a tool call and the command line always exist", () => {
    expect(invocationModes({ hooks: [], schedules: [] })).toEqual(["http", "mcp", "cli"]);
  });

  test("a hook or a schedule is a tab only when one is bound", () => {
    expect(invocationModes({ hooks: [hook], schedules: [] })).toEqual([
      "http",
      "webhook",
      "mcp",
      "cli",
    ]);
    expect(invocationModes({ hooks: [hook], schedules: [schedule] })).toEqual([
      "http",
      "webhook",
      "mcp",
      "schedule",
      "cli",
    ]);
  });

  test("bindings the reader may not see are no tabs", () => {
    expect(invocationModes({})).toEqual(["http", "mcp", "cli"]);
  });
});

describe("initialInvocationMode", () => {
  const all = invocationModes({ hooks: [hook], schedules: [schedule] });

  test("the tab a reader lands on is the way the workflow is really started", () => {
    expect(initialInvocationMode(all, "schedule")).toBe("schedule");
    expect(initialInvocationMode(all, "webhook")).toBe("webhook");
    expect(initialInvocationMode(all, "request")).toBe("http");
  });

  test("a trigger whose tab does not exist falls back to the request", () => {
    const plain = invocationModes({ hooks: [], schedules: [] });
    expect(initialInvocationMode(plain, "schedule")).toBe("http");
    expect(initialInvocationMode(plain, "webhook")).toBe("http");
    expect(initialInvocationMode(plain, null)).toBe("http");
  });
});

describe("words", () => {
  test("a signing scheme goes by its own name; an unknown one by its value", () => {
    expect(verifierName("standard")).toBe("Standard Webhooks");
    expect(verifierName("hmac")).toBe("HMAC");
    expect(verifierName("custom")).toBe("custom");
  });

  test("every binding state has a word in both catalogs", () => {
    for (const key of [...Object.values(HOOK_STATE_KEYS), ...Object.values(SCHEDULE_STATE_KEYS)]) {
      expect(CATALOGS.en[key], key).toBeTruthy();
      expect(CATALOGS.de[key], key).toBeTruthy();
    }
  });
});

describe("hasFixedInput", () => {
  test("an empty input is not worth a block", () => {
    expect(hasFixedInput(null)).toBe(false);
    expect(hasFixedInput(undefined)).toBe(false);
    expect(hasFixedInput({})).toBe(false);
  });

  test("anything else is", () => {
    expect(hasFixedInput({ report: "daily" })).toBe(true);
    expect(hasFixedInput([])).toBe(true);
    expect(hasFixedInput("text")).toBe(true);
    expect(hasFixedInput(0)).toBe(true);
  });
});
