import { describe, expect, test } from "bun:test";
import {
  callVerdict,
  HOOK_STATE_KEYS,
  hasFixedInput,
  hiddenInvocationKey,
  hiddenInvocationLists,
  invocationModes,
  isWorkflowInvocation,
  SCHEDULE_STATE_KEYS,
  scheduleRowKey,
  verifierName,
} from "@/features/workflows/model/workflow-invocation";
import { CATALOGS } from "@/lib/i18n";

describe("isWorkflowInvocation", () => {
  const answer = {
    http: { path: "/v1/executions", body: {} },
    mcp: {},
    cli: {},
    input: { sample: {} },
    output: {},
    authority: {},
    visibility: { hooks: true, schedules: true },
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
  test("schedule and webhook come first, as cards even while none is bound", () => {
    expect(invocationModes({ visibility: { hooks: true, schedules: true } })).toEqual([
      "schedule",
      "webhook",
      "http",
      "mcp",
      "cli",
    ]);
  });

  test("bindings the reader may not see are no cards", () => {
    expect(invocationModes({ visibility: { hooks: false, schedules: false } })).toEqual([
      "http",
      "mcp",
      "cli",
    ]);
    expect(invocationModes({ visibility: { hooks: true, schedules: false } })).toEqual([
      "webhook",
      "http",
      "mcp",
      "cli",
    ]);
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

describe("schedule rows", () => {
  test("a development and a production schedule with the same cron keep apart", () => {
    const rows = [
      { cron: "0 7 * * *", timezone: "Europe/Berlin", environment: "dev" },
      { cron: "0 7 * * *", timezone: "Europe/Berlin", environment: "prod" },
      { cron: "0 7 * * *", timezone: "Europe/Berlin", environment: "prod" },
    ];
    const keys = rows.map(scheduleRowKey);
    expect(new Set(keys).size).toBe(rows.length);
  });

  test("the command line says where it runs, and how to reach production", () => {
    expect(CATALOGS.de["invocation.cli.runsInDev"]).toContain("im Test");
    expect(CATALOGS.de["invocation.cli.runsInDev"]).toContain("HTTP-Aufruf");
    expect(CATALOGS.en["invocation.cli.runsInDev"]).toContain("development");
    expect(CATALOGS.en["invocation.cli.runsInDev"]).toContain("HTTP call");
  });
});

describe("a list the reader may not see", () => {
  test("is named as hidden — never read as empty", () => {
    const hidden = (hooks: boolean, schedules: boolean) =>
      hiddenInvocationLists({ visibility: { hooks, schedules } });
    expect(hidden(true, true)).toEqual([]);
    expect(hiddenInvocationKey(hidden(true, true))).toBeNull();
    expect(hiddenInvocationKey(hidden(false, true))).toBe("invocation.hidden.hooks");
    expect(hiddenInvocationKey(hidden(true, false))).toBe("invocation.hidden.schedules");
    expect(hiddenInvocationKey(hidden(false, false))).toBe("invocation.hidden.both");
  });

  test("the line says that there may be some, in both languages", () => {
    for (const key of [
      "invocation.hidden.hooks",
      "invocation.hidden.schedules",
      "invocation.hidden.both",
    ] as const) {
      expect(CATALOGS.de[key]).toContain("darfst du nicht sehen");
      expect(CATALOGS.de[key]).not.toMatch(/[Kk]ein/);
      expect(CATALOGS.en[key]).toContain("may not see");
    }
  });

  test("an answer without the visibility is not an invocation", () => {
    expect(
      isWorkflowInvocation({
        http: { path: "/v1/executions", body: {} },
        mcp: {},
        cli: {},
        input: { sample: {} },
        output: {},
        authority: {},
        webhook_input_shape: {},
      }),
    ).toBe(false);
  });
});

describe("what a call will be", () => {
  const stored = { dev: "held_preview_only", prod: "live_run_allowed" } as const;
  const invocation = { authority: stored, invalid: false };

  test("live only where the panel shows the environment as approved", () => {
    expect(callVerdict(invocation, "prod", "prod")).toBe("live");
  });

  test("a stored approval the panel does not confirm promises nothing", () => {
    expect(callVerdict(invocation, "prod", null)).toBe("unconfirmed");
    expect(callVerdict(invocation, "prod", "dev")).toBe("unconfirmed");
  });

  test("no stored approval is a trial run, whatever the panel says", () => {
    expect(callVerdict(invocation, "dev", null)).toBe("preview");
    expect(callVerdict(invocation, "dev", "dev")).toBe("preview");
  });

  test("a version in an earlier format is refused in every environment", () => {
    const legacy = { authority: stored, invalid: true };
    expect(callVerdict(legacy, "prod", "prod")).toBe("refused");
    expect(callVerdict(legacy, "dev", null)).toBe("refused");
  });

  test("the unconfirmed line promises no live run", () => {
    expect(CATALOGS.de["invocation.http.unconfirmed"]).toContain("nicht bestätigt");
    expect(CATALOGS.de["invocation.http.unconfirmed"]).toContain("Probe-Run");
    expect(CATALOGS.en["invocation.http.unconfirmed"]).toContain("not confirmed");
  });
});
