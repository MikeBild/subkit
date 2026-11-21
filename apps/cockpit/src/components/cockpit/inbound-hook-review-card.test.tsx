import { expect, mock, test } from "bun:test";
import type { InboundHookAutomation } from "@/api/decisions";

const CHILD_FLAG = "SUBKIT_INBOUND_HOOK_REVIEW_CARD_CHILD";

function isolated(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (process.env[CHILD_FLAG] !== "1") {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path, "-t", name], {
        env: { ...process.env, [CHILD_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      return;
    }
    await body();
  });
}

const heldHook = (reasonCode: "execution_authority_required" | "execution_authority_unavailable") =>
  ({
    inbound_hook_id: "hook-1",
    workflow_id: "workflow-1",
    slug: "nightly-report",
    state: "approval_required",
    ready: false,
    environment: "prod",
    admission_hold: { reason_code: reasonCode, observed_at: "2026-11-09T09:00:00.000Z" },
    last_refused_at: "2026-11-09T09:05:00.000Z",
    last_refused_reason: "authority_required",
  }) satisfies InboundHookAutomation;

isolated("renders the held hook's concrete admission reason and its review action", async () => {
  mock.module("@/components/cockpit/automation-grant", () => ({
    AutomationGrant: (props: { workflowId: string; environment: string; testId: string }) => (
      <button
        data-environment={props.environment}
        data-testid={props.testId}
        type="button"
        value={props.workflowId}
      />
    ),
  }));
  const { InboundHookReviewCard } = await import("./inbound-hook-review-card");
  const { render } = await import("./patterns/test-utils");

  const markup = render(<InboundHookReviewCard hook={heldHook("execution_authority_required")} />);

  expect(markup).toContain('data-testid="inbound-hook-admission-held"');
  expect(markup).toContain("Webhook „nightly-report“");
  expect(markup).toContain('data-testid="inbound-hook-admission-since"');
  expect(markup).toContain('data-testid="inbound-hook-admission-review"');
  expect(markup).toContain('data-environment="prod"');
});

isolated(
  "keeps an unavailable authority distinguishable from an authority that still needs review",
  async () => {
    mock.module("@/components/cockpit/automation-grant", () => ({
      AutomationGrant: () => <button data-testid="inbound-hook-admission-review" type="button" />,
    }));
    const { InboundHookReviewCard } = await import("./inbound-hook-review-card");
    const { render } = await import("./patterns/test-utils");

    const concrete = render(
      <InboundHookReviewCard hook={heldHook("execution_authority_required")} />,
    );
    const unavailable = render(
      <InboundHookReviewCard hook={heldHook("execution_authority_unavailable")} />,
    );

    expect(concrete).toContain(
      "Aktionen und Ziele dieses Workflows für unbeaufsichtigte Runs nicht geprüft",
    );
    expect(unavailable).toContain("Freigabe fehlt, abgelaufen, widerrufen oder aufgebraucht ist");
    expect(unavailable).not.toContain(
      "Aktionen und Ziele dieses Workflows für unbeaufsichtigte Runs nicht geprüft",
    );
  },
);
