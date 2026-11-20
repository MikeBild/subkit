import { describe, expect, test } from "bun:test";
import { cockpitPushPayload } from "../identity/cockpit-push.ts";
import type { AttentionItem } from "../operator/attention.ts";
import { cockpitPushAttentionPayload } from "./cockpit-push-attention.ts";

const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";

function item(overrides: Partial<AttentionItem> & Pick<AttentionItem, "id">): AttentionItem {
  return {
    class: "failing",
    severity: "urgent",
    kind: "connector",
    subject: { kind: "connector", id: CONNECTOR, name: "Payroll export for Acme" },
    reason: "needs_reauth",
    trigger: null,
    cause_class: null,
    counts: {},
    since: null,
    deadline: null,
    detail: "token expired for acme@example.test",
    actions: [
      {
        verb: "reauth",
        href: `/cockpit/connectors/${CONNECTOR}`,
        primary: true,
        permission: "connector:write",
      },
    ],
    ...overrides,
  } as AttentionItem;
}

function parse(payload: string): {
  type: string;
  items: Array<Record<string, unknown>>;
  more: number;
} {
  return JSON.parse(payload);
}

describe("cockpit push payload", () => {
  test("names each new attention item by id, class, severity and primary address only", () => {
    const payload = parse(
      cockpitPushAttentionPayload(
        [
          item({ id: `connector:${CONNECTOR}` }),
          item({
            id: `workflow:${WORKFLOW}`,
            class: "stopped",
            severity: "critical",
            actions: [
              { verb: "open_runs", href: "/cockpit/runs", primary: false, permission: "x" },
              {
                verb: "review",
                href: `/cockpit?review=workflow:${WORKFLOW}`,
                primary: true,
                permission: "workflow:write",
              },
            ],
          }),
        ],
        new Set(),
      ),
    );
    expect(payload).toEqual({
      type: "attention",
      items: [
        {
          id: `connector:${CONNECTOR}`,
          class: "failing",
          severity: "urgent",
          href: `/cockpit/connectors/${CONNECTOR}`,
        },
        {
          id: `workflow:${WORKFLOW}`,
          class: "stopped",
          severity: "critical",
          href: `/cockpit?review=workflow:${WORKFLOW}`,
        },
      ],
      more: 0,
    });
  });

  test("carries no name, detail or reason", () => {
    const raw = cockpitPushAttentionPayload([item({ id: `connector:${CONNECTOR}` })], new Set());
    expect(raw).not.toContain("Payroll");
    expect(raw).not.toContain("acme@example.test");
    expect(raw).not.toContain("needs_reauth");
  });

  test("an id that embeds a workspace-chosen name is counted, not sent", () => {
    const payload = parse(
      cockpitPushAttentionPayload(
        [item({ id: "secret-approval:acme-payroll-key@3" }), item({ id: "skills" })],
        new Set(),
      ),
    );
    expect(payload.items.map((entry) => entry.id)).toEqual(["skills"]);
    expect(payload.more).toBe(1);
    expect(JSON.stringify(payload)).not.toContain("acme-payroll-key");
  });

  test("an address outside the Cockpit is dropped", () => {
    const payload = parse(
      cockpitPushAttentionPayload(
        [
          item({
            id: "budget",
            actions: [
              { verb: "open", href: "https://evil.example/x", primary: true, permission: "x" },
            ],
          }),
          item({ id: "skills", actions: [] }),
        ],
        new Set(),
      ),
    );
    expect(payload.items.map((entry) => entry.href)).toEqual([null, null]);
  });

  test("stays small enough for a push message and counts what it leaves out", () => {
    const targets = Array.from({ length: 40 }, (_, index) => ({
      id: `workflow:${WORKFLOW.slice(0, -2)}${String(index).padStart(2, "0")}`,
      class: "failing",
      severity: "urgent",
      href: `/cockpit/workflows/${WORKFLOW}#workflow-automation`,
    }));
    const raw = cockpitPushPayload(targets, 2);
    const payload = parse(raw);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(2800);
    expect(payload.items.length).toBeLessThanOrEqual(8);
    expect(payload.items.length + payload.more).toBe(42);
  });
});
