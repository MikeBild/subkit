import { describe, expect, test } from "bun:test";
import { attentionHref, chatNewHref, connectorHref, workflowAutomationHref } from "@/app/links";
import { type Remedy, type RemedyInput, remedyFor } from "@/lib/remedy";

const WF = "0b6f2d4e-91c3-4a7e-8d52-3f1e6a9c7b20";
const RUN = "7d3a1c58-2e4b-4f96-b0a1-9c8e5d2f4a13";
const CONNECTOR = "c41e9a07-5b2d-4d38-a6f1-e2b7c9d80f54";

const base: RemedyInput = { workflowId: WF, executionId: RUN, canRun: true, canChat: true };

describe("remedyFor", () => {
  const cases: Array<[string, RemedyInput, { kind: Remedy["kind"]; href: string } | null]> = [
    [
      "an open repair proposal wins over everything",
      {
        ...base,
        patch: { id: "p1" },
        authState: { connectorId: CONNECTOR, state: "expired" },
      },
      { kind: "review_repair", href: attentionHref({ review: `workflow:${WF}` }) },
    ],
    [
      "an expired sign-in leads to the connector",
      { ...base, authState: { connectorId: CONNECTOR, state: "expired" } },
      { kind: "reauth", href: connectorHref(CONNECTOR) },
    ],
    [
      "missing credentials lead to the connector too",
      { ...base, authState: { connectorId: CONNECTOR, state: "credentials_missing" } },
      { kind: "reauth", href: connectorHref(CONNECTOR) },
    ],
    [
      "a rejected request on a connector that reports itself connected is checked, not re-signed",
      { ...base, authState: { connectorId: CONNECTOR, state: "connected" } },
      { kind: "check_auth", href: connectorHref(CONNECTOR) },
    ],
    [
      "an unproven sign-in never claims expiry (a 403 may be a missing scope)",
      { ...base, authState: { connectorId: CONNECTOR, state: "unproven" } },
      { kind: "check_auth", href: connectorHref(CONNECTOR) },
    ],
    [
      "otherwise the chat, with workflow and run attached",
      base,
      { kind: "chat", href: chatNewHref({ workflowId: WF, executionId: RUN }) },
    ],
    [
      "a repair proposal needs no chat permission",
      { ...base, canChat: false, patch: { id: "p1" } },
      { kind: "review_repair", href: attentionHref({ review: `workflow:${WF}` }) },
    ],
    [
      "a held workflow leads to its approval, before a lost sign-in",
      {
        ...base,
        held: true,
        authState: { connectorId: CONNECTOR, state: "expired" },
      },
      { kind: "grant", href: workflowAutomationHref(WF) },
    ],
    [
      "a repair proposal still wins over a hold",
      { ...base, held: true, patch: { id: "p1" } },
      { kind: "review_repair", href: attentionHref({ review: `workflow:${WF}` }) },
    ],
    [
      "on the connector's own surfaces a lost sign-in lands on its sign-in card",
      { ...base, authState: { connectorId: CONNECTOR, state: "expired", section: "credentials" } },
      { kind: "reauth", href: `${connectorHref(CONNECTOR)}?tab=connection` },
    ],
    ["no chat permission and nothing else: no dead link", { ...base, canChat: false }, null],
    [
      "permission to run alone never produces a remedy",
      { workflowId: WF, canRun: true, canChat: false },
      null,
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      const remedy = remedyFor(input);
      expect(remedy ? { kind: remedy.kind, href: remedy.href } : null).toEqual(expected);
    });
  }

  test("the connector's own surfaces say reconnect; a run page says sign in again", () => {
    const state = { connectorId: CONNECTOR, state: "expired" };
    expect(remedyFor({ ...base, authState: state })?.labelKey).toBe("remedy.reauth");
    expect(remedyFor({ ...base, authState: { ...state, section: "credentials" } })?.labelKey).toBe(
      "remedy.reconnect",
    );
  });

  test("carries the opening question into the chat address", () => {
    const remedy = remedyFor({ ...base, prompt: "Warum?" });
    expect(remedy?.href).toBe(chatNewHref({ prompt: "Warum?", workflowId: WF, executionId: RUN }));
  });

  test("every remedy address is router-relative", () => {
    for (const [, input] of cases) {
      const remedy = remedyFor(input);
      if (remedy) expect(remedy.href.startsWith("/cockpit")).toBe(false);
    }
  });
});
