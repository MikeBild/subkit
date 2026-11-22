import { describe, expect, test } from "bun:test";
import type { EngineClient, OperatorHealthDigest } from "../engine-client.ts";
import {
  attention,
  attentionItem,
  attentionSources,
  operatorDigest,
} from "../tests/_helpers/operator-digest-fixtures.ts";
import { digestAsContext, fetchOperatorDigest, riskSummaryLine } from "./operator-digest.ts";

function digest(overrides: Partial<OperatorHealthDigest> = {}): OperatorHealthDigest {
  return operatorDigest({ headline: "Needs attention: 1 item (1 failing).", ...overrides });
}

function clientReturning(d: OperatorHealthDigest): EngineClient {
  return { getOperatorHealthDigest: async () => d } as unknown as EngineClient;
}

const connectorItem = attentionItem({
  id: "connector:c1",
  class: "failing",
  severity: "urgent",
  kind: "connector",
  subject: { kind: "connector", id: "c1", name: "CRM" },
  reason: "needs_reauth",
  actions: [
    {
      verb: "reauth",
      href: "/cockpit/connectors/c1",
      primary: true,
      permission: "connector:oauth",
    },
  ],
});

describe("digestAsContext", () => {
  test("names every attention item — kinds the digest does not detail included", () => {
    const text = digestAsContext(
      digest({
        attention: attention({ items: [connectorItem] }),
      }),
    );
    expect(text).toContain("connector CRM: needs reauth");
    expect(text).toContain("/cockpit/connectors/c1");
  });

  test("says which sources could not be read, so the model does not call them clear", () => {
    const text = digestAsContext(
      digest({
        attention: attention({ sources: attentionSources({ connections: "failed" }) }),
      }),
    );
    expect(text).toContain("Could not be read: connections");
  });
});

describe("subkit login risk line", () => {
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
