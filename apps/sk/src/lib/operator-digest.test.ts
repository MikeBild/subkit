// The sk side of the attention list: what the model is told at REPL start and
// what `sk login` prints.

import { describe, expect, test } from "bun:test";
import type { EngineClient, OperatorHealthDigest } from "../engine-client.ts";
import { digestAsContext, fetchOperatorDigest, riskSummaryLine } from "./operator-digest.ts";

function digest(overrides: Partial<OperatorHealthDigest> = {}): OperatorHealthDigest {
  return {
    generated_at: "2026-06-22T08:00:00Z",
    window_hours: 24,
    headline: "Needs attention: 1 item (1 failing).",
    failure_groups: [],
    patch_candidates: { open: 0, items: [] },
    risk: [],
    attention: { schema_version: "attention.v1", sources: {}, items: [] },
    rendered: "",
    all_clear: false,
    ...overrides,
  };
}

function clientReturning(d: OperatorHealthDigest): EngineClient {
  return { getOperatorHealthDigest: async () => d } as unknown as EngineClient;
}

const connectorItem = {
  id: "connector:c1",
  class: "failing" as const,
  severity: "urgent" as const,
  kind: "connector",
  subject: { kind: "connector", id: "c1", name: "CRM" },
  reason: "needs_reauth",
  counts: {},
  since: null,
  deadline: null,
  detail: null,
  actions: [
    {
      verb: "reauth",
      href: "/cockpit/connectors/c1",
      primary: true,
      permission: "connector:oauth",
    },
  ],
};

describe("digestAsContext", () => {
  test("names every attention item — kinds the digest does not detail included", () => {
    const text = digestAsContext(
      digest({
        attention: {
          schema_version: "attention.v1",
          sources: { connectors: "answered" },
          items: [connectorItem],
        },
      }),
    );
    expect(text).toContain("connector CRM: needs reauth");
    expect(text).toContain("/cockpit/connectors/c1");
  });

  test("says which sources could not be read, so the model does not call them clear", () => {
    const text = digestAsContext(
      digest({
        attention: {
          schema_version: "attention.v1",
          sources: { connections: "failed", skills: "answered" },
          items: [],
        },
      }),
    );
    expect(text).toContain("Could not be read: connections");
  });
});

describe("sk login risk line", () => {
  test("a warning trend is printed even when nothing needs acting on", async () => {
    const line = await riskSummaryLine(
      clientReturning(
        digest({
          all_clear: true,
          risk: [
            {
              kind: "llm_fallback",
              severity: "warn",
              headline: "30% of LLM calls fell back",
              detail: "d",
              metric: "m",
              value: 30,
              threshold: 20,
            },
          ],
        }),
      ),
    );
    expect(line).toContain("30% of LLM calls fell back");
  });

  test("the REPL's startup digest still stays away when nothing needs attention", async () => {
    expect(await fetchOperatorDigest(clientReturning(digest({ all_clear: true })))).toBeNull();
  });
});
