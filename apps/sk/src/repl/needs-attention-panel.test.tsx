import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { AttentionItem, OperatorHealthDigest } from "../engine-client.ts";
import type { PersonaProbe } from "../slash.ts";
import {
  attention,
  attentionItem,
  attentionSources,
  digestPatch,
  failureGroup,
  operatorDigest,
} from "../tests/_helpers/operator-digest-fixtures.ts";
import { NeedsAttentionPanel } from "./needs-attention-panel.tsx";
import { buildStarterActions } from "./starter-action-injection.ts";

const ANSI_RE = /\[[0-9;]*m/g;
function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(ANSI_RE, "");
}

function makeDigest(overrides: Partial<OperatorHealthDigest> = {}): OperatorHealthDigest {
  return operatorDigest({ headline: "2 failures in the last 24h", ...overrides });
}

const mkGroup = failureGroup;

describe("NeedsAttentionPanel — failure groups", () => {
  test("renders the workflow name for each failure group", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-a",
              workflow_id: "wf-1",
              workflow_name: "Send invoice email",
              step_key: "email",
              error_code: "SMTP_AUTH",
              origin: "scheduled",
              scheduled_count: 1,
              count: 3,
              last_seen: "2026-06-22T07:30:00Z",
              resolved_at: null,
              cause: "SMTP authentication failed",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("Send invoice email");
    ui.unmount();
  });

  test("renders 'failed N×' count for a repeated failure", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-b",
              workflow_id: "wf-2",
              workflow_name: "Sync CRM",
              step_key: "fetch",
              error_code: "TIMEOUT",
              origin: "manual",
              scheduled_count: 0,
              count: 5,
              last_seen: "2026-06-22T06:00:00Z",
              resolved_at: null,
              cause: "Request timed out after 30s",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("failed 5×");
    ui.unmount();
  });

  test("renders 'failed once' for count === 1", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-c",
              workflow_id: "wf-3",
              workflow_name: "Daily report",
              step_key: "render",
              error_code: null,
              origin: "manual",
              scheduled_count: 0,
              count: 1,
              last_seen: "2026-06-22T05:00:00Z",
              resolved_at: null,
              cause: "Template variable missing",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("failed once");
    ui.unmount();
  });

  test("renders the cause string for each failure group", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-d",
              workflow_id: "wf-4",
              workflow_name: "Webhook relay",
              step_key: "post",
              error_code: "HTTP_500",
              origin: "scheduled",
              scheduled_count: 1,
              count: 2,
              last_seen: "2026-06-22T04:00:00Z",
              resolved_at: null,
              cause: "Upstream returned HTTP 500 — Internal Server Error",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("Upstream returned HTTP 500 — Internal Server Error");
    ui.unmount();
  });

  test("falls back to '(draft)' when both workflow_name and workflow_id are null", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-draft",
              workflow_id: null,
              workflow_name: null,
              step_key: null,
              error_code: null,
              origin: "authoring",
              scheduled_count: 0,
              count: 1,
              last_seen: "2026-06-22T03:00:00Z",
              resolved_at: null,
              cause: "Step output schema mismatch",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("(draft)");
    ui.unmount();
  });

  test("renders multiple failure groups from the fixture", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-1",
              workflow_id: "wf-a",
              workflow_name: "Alpha workflow",
              step_key: "step-1",
              error_code: "ERR_A",
              origin: "scheduled",
              scheduled_count: 1,
              count: 4,
              last_seen: "2026-06-22T07:00:00Z",
              resolved_at: null,
              cause: "Connection refused",
              guidance: null,
            }),
            mkGroup({
              signature: "sig-2",
              workflow_id: "wf-b",
              workflow_name: "Beta workflow",
              step_key: "step-2",
              error_code: "ERR_B",
              origin: "manual",
              scheduled_count: 0,
              count: 2,
              last_seen: "2026-06-22T06:00:00Z",
              resolved_at: null,
              cause: "Invalid credentials",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("Alpha workflow");
    expect(frame).toContain("failed 4×");
    expect(frame).toContain("Connection refused");
    expect(frame).toContain("Beta workflow");
    expect(frame).toContain("failed 2×");
    expect(frame).toContain("Invalid credentials");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — recovered causes", () => {
  test("a cause the schedule has recovered from says so, and a live one does not", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "healed",
              workflow_name: "Monthly report",
              origin: "scheduled",
              scheduled_count: 4,
              count: 4,
              cause: "The store refused the write.",
              resolved_at: "2026-06-23T04:12:00Z",
            }),
            mkGroup({
              signature: "live",
              workflow_name: "Hourly sync",
              origin: "scheduled",
              scheduled_count: 9,
              count: 9,
              cause: "The address answered 404.",
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("Monthly report");
    expect(frame).toContain("last ran clean on its schedule");
    expect(frame.split("last ran clean on its schedule")).toHaveLength(2);
    expect(frame).toContain("The address answered 404.");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — prose hygiene", () => {
  test("does NOT contain 'Reply yes'", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-x",
              workflow_id: "wf-x",
              workflow_name: "Some workflow",
              step_key: "s",
              error_code: null,
              origin: "scheduled",
              scheduled_count: 1,
              count: 3,
              last_seen: "2026-06-22T07:00:00Z",
              resolved_at: null,
              cause: "Step crashed",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    expect(snapshot(ui)).not.toContain("Reply yes");
    ui.unmount();
  });

  test("does NOT contain 'I noticed'", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-y",
              workflow_id: "wf-y",
              workflow_name: "Another workflow",
              step_key: "s",
              error_code: null,
              origin: "manual",
              scheduled_count: 0,
              count: 1,
              last_seen: "2026-06-22T07:00:00Z",
              resolved_at: null,
              cause: "Unexpected error",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    expect(snapshot(ui)).not.toContain("I noticed");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — patch candidates", () => {
  test("renders the open self-healing fix count and summary", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          patch_candidates: {
            open: 2,
            items: [
              digestPatch({
                id: "patch-001",
                workflow_id: "wf-p1",
                workflow_name: "Nightly report",
                classification: "safe",
                summary: "Add null guard on step output",
              }),
              digestPatch({
                id: "patch-002",
                workflow_id: "wf-p2",
                workflow_name: "Daily sync",
                classification: "safe",
                summary: "Retry with exponential backoff",
              }),
            ],
          },
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("self-healing fix");
    expect(frame).toContain("Add null guard on step output");
    expect(frame).toContain("Retry with exponential backoff");
    ui.unmount();
  });

  test("renders nothing for patch candidates when open === 0", () => {
    const ui = render(
      <NeedsAttentionPanel digest={makeDigest({ patch_candidates: { open: 0, items: [] } })} />,
    );
    const frame = snapshot(ui);
    expect(frame).not.toContain("self-healing fix");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — risk signals", () => {
  test("renders risk signal headline and detail", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          risk: [
            {
              kind: "failure_rate_spike",
              severity: "critical",
              headline: "Failure rate spike detected",
              detail: "15% of runs failed in the last hour, threshold is 5%",
              metric: "failure_rate",
              value: 0.15,
              threshold: 0.05,
            },
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("Failure rate spike detected");
    expect(frame).toContain("15% of runs failed");
    ui.unmount();
  });

  test("renders nothing for risk when array is empty", () => {
    const ui = render(<NeedsAttentionPanel digest={makeDigest({ risk: [] })} />);
    const frame = snapshot(ui);
    expect(frame).not.toContain("Risk signals");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — totals header", () => {
  test("shows total failure count and window_hours in header", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          window_hours: 48,
          failure_groups: [
            mkGroup({
              signature: "sig-h1",
              workflow_id: "wf-h",
              workflow_name: "Header test",
              step_key: null,
              error_code: null,
              origin: "mixed",
              scheduled_count: 1,
              count: 7,
              last_seen: "2026-06-22T07:00:00Z",
              resolved_at: null,
              cause: "Mixed error",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("7 failures");
    expect(frame).toContain("48h");
    ui.unmount();
  });

  test("singularises 'failure' when count === 1", () => {
    const ui = render(
      <NeedsAttentionPanel
        digest={makeDigest({
          failure_groups: [
            mkGroup({
              signature: "sig-sing",
              workflow_id: "wf-s",
              workflow_name: "Singular",
              step_key: null,
              error_code: null,
              origin: "manual",
              scheduled_count: 0,
              count: 1,
              last_seen: "2026-06-22T07:00:00Z",
              resolved_at: null,
              cause: "One error",
              guidance: null,
            }),
          ],
        })}
      />,
    );
    const frame = snapshot(ui);
    expect(frame).toContain("1 failure");
    expect(frame).not.toContain("1 failures");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — empty digest", () => {
  test("renders only the header (0 failures) with no failure / patch / risk rows", () => {
    const ui = render(<NeedsAttentionPanel digest={makeDigest()} />);
    const frame = snapshot(ui);
    expect(frame).toContain("needs attention");
    expect(frame).toContain("0 failures");
    expect(frame).not.toContain("failed");
    expect(frame).not.toContain("self-healing fix");
    expect(frame).not.toContain("Risk signals");
    ui.unmount();
  });
});

function attentionEntry(
  id: string,
  klass: AttentionItem["class"],
  subject: AttentionItem["subject"],
  reason: AttentionItem["reason"],
  verb: AttentionItem["actions"][number]["verb"],
  href: string,
): AttentionItem {
  return attentionItem({
    id,
    class: klass,
    kind: subject?.kind ?? "skill_candidates",
    subject,
    reason,
    actions: [{ verb, href, primary: true, permission: "x" }],
  });
}

describe("NeedsAttentionPanel — the attention list", () => {
  test("lists every item, whatever its kind, with its reason and where to act", () => {
    const digest = makeDigest({
      attention: attention({
        sources: attentionSources({ connections: "failed" }),
        items: [
          attentionEntry(
            "connector:c1",
            "failing",
            { kind: "connector", id: "c1", name: "CRM" },
            "needs_reauth",
            "reauth",
            "/cockpit/connectors/c1",
          ),
          attentionEntry(
            "conversation:k1",
            "stopped",
            { kind: "conversation", id: "k1", name: "Mine" },
            "awaiting_answer",
            "answer",
            "/cockpit/chat/k1",
          ),
          attentionEntry(
            "skills",
            "decide",
            null,
            "skills_proposed",
            "review",
            "/cockpit?review=skills",
          ),
        ],
      }),
    });
    const ui = render(<NeedsAttentionPanel digest={digest} />);
    const frame = snapshot(ui).replace(/\s+/g, " ");
    expect(frame).toContain("3 items");
    expect(frame).toContain("connector CRM: needs reauth");
    expect(frame).toContain("/cockpit/connectors/c1");
    expect(frame).toContain("conversation Mine: awaiting answer");
    expect(frame).toContain("/cockpit/chat/k1");
    expect(frame).toContain("skills proposed");
    expect(frame).toContain("could not be read: connections");
    ui.unmount();
  });
});

describe("NeedsAttentionPanel — count matches the starter-action label", () => {
  test("panel header N equals buildStarterActions label N for the same digest", () => {
    const allowAll: PersonaProbe = { allows: () => true };
    const digest = makeDigest({
      failure_groups: [
        mkGroup({ signature: "g1", count: 2 }),
        mkGroup({ signature: "g2", count: 3 }),
      ],
    });
    const ui = render(<NeedsAttentionPanel digest={digest} />);
    expect(snapshot(ui)).toContain("5 failures");
    const actions = buildStarterActions("admin", allowAll, digest);
    expect(actions[0]?.label).toBe("Fix 5 failures");
    ui.unmount();
  });
});
