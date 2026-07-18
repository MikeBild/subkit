// Trigger schema parsing — discriminated union over how a workflow
// run is initiated. Verifies the implicit `request` default, the
// shape of the `webhook` and `schedule` variants, and that bad
// trigger blocks reject at parse time.

import { describe, expect, test } from "bun:test";
import {
  ScheduleTriggerSchema,
  TriggerSchema,
  WebhookTriggerSchema,
  WorkflowDefSchema,
} from "../types.ts";

const baseDef = {
  name: "wf",
  steps: [
    {
      id: "s1",
      kind: "transform" as const,
      expression: "return input.input;",
      language: "javascript" as const,
    },
  ],
};

describe("WorkflowDef.trigger", () => {
  test("workflow without a trigger block parses (implicit request)", () => {
    const parsed = WorkflowDefSchema.parse(baseDef);
    expect(parsed.trigger).toBeUndefined();
  });

  test("explicit { kind: 'request' } trigger round-trips", () => {
    const parsed = WorkflowDefSchema.parse({
      ...baseDef,
      trigger: { kind: "request" },
    });
    expect(parsed.trigger).toEqual({ kind: "request" });
  });

  test("webhook trigger parses with required fields", () => {
    const parsed = WorkflowDefSchema.parse({
      ...baseDef,
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["invoice.paid", "invoice.updated"],
        verify: "stripe-signature",
      },
    });
    expect(parsed.trigger).toEqual({
      kind: "webhook",
      source: "stripe",
      events: ["invoice.paid", "invoice.updated"],
      verify: "stripe-signature",
    });
  });

  test("schedule trigger fills tz default UTC", () => {
    const parsed = WorkflowDefSchema.parse({
      ...baseDef,
      trigger: {
        kind: "schedule",
        cron: "0 9 * * *",
      },
    });
    expect(parsed.trigger).toMatchObject({
      kind: "schedule",
      cron: "0 9 * * *",
      tz: "UTC",
    });
  });

  test("schedule trigger accepts business_days_only + skip_dates", () => {
    const parsed = WorkflowDefSchema.parse({
      ...baseDef,
      trigger: {
        kind: "schedule",
        cron: "0 9 * * MON-FRI",
        tz: "Europe/Berlin",
        business_days_only: true,
        skip_dates: ["2026-12-25", "2026-01-01"],
      },
    });
    expect(parsed.trigger).toMatchObject({
      kind: "schedule",
      tz: "Europe/Berlin",
      business_days_only: true,
      skip_dates: ["2026-12-25", "2026-01-01"],
    });
  });

  test("schedule trigger accepts an explicit connector execution mode", () => {
    const parsed = WorkflowDefSchema.parse({
      ...baseDef,
      trigger: {
        kind: "schedule",
        cron: "0 * * * *",
        tz: "UTC",
        execution_mode: "prod",
      },
    });
    expect(parsed.trigger).toMatchObject({ execution_mode: "prod" });
  });

  test("schedule trigger rejects an unknown connector execution mode", () => {
    expect(() =>
      ScheduleTriggerSchema.parse({
        kind: "schedule",
        cron: "0 * * * *",
        execution_mode: "staging",
      }),
    ).toThrow();
  });

  test("rejects unknown trigger kind", () => {
    expect(() =>
      WorkflowDefSchema.parse({
        ...baseDef,
        trigger: { kind: "polling", source: "x" },
      }),
    ).toThrow();
  });

  test("rejects webhook trigger missing source", () => {
    expect(() =>
      WebhookTriggerSchema.parse({
        kind: "webhook",
        events: [],
        verify: "none",
      }),
    ).toThrow();
  });

  test("rejects webhook trigger with invalid verify mode", () => {
    expect(() =>
      WebhookTriggerSchema.parse({
        kind: "webhook",
        source: "stripe",
        events: [],
        verify: "rsa",
      }),
    ).toThrow();
  });

  test("rejects schedule trigger with empty cron", () => {
    expect(() => ScheduleTriggerSchema.parse({ kind: "schedule", cron: "" })).toThrow();
  });

  test("rejects schedule trigger with non-ISO skip_dates entry", () => {
    expect(() =>
      ScheduleTriggerSchema.parse({
        kind: "schedule",
        cron: "0 9 * * *",
        skip_dates: ["12/25/2026"],
      }),
    ).toThrow();
  });

  test("TriggerSchema discriminator is exhaustive", () => {
    expect(TriggerSchema.parse({ kind: "request" }).kind).toBe("request");
    expect(
      TriggerSchema.parse({
        kind: "webhook",
        source: "github",
        events: [],
        verify: "github-hmac",
      }).kind,
    ).toBe("webhook");
    expect(
      TriggerSchema.parse({
        kind: "schedule",
        cron: "*/5 * * * *",
      }).kind,
    ).toBe("schedule");
  });
});
