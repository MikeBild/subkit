import { describe, expect, test } from "bun:test";
import type { Setup } from "@/api/setup";
import { answersFromSetup } from "@/features/setup";
import { render } from "@/pages/settings-fixtures";
import { ApprovalPolicyPanel } from "./approval-policy";
import { NotificationsPanel } from "./notifications";
import { notificationView } from "./notifications-model";
import { PauseRow } from "./pause-row";
import { SetupSectionPanel } from "./setup-section";
import type { PauseControl } from "./use-notification-pause";

const stored = {
  default_chat_mode: "auto",
  default_environment: "dev",
  approver: {
    kind: "teammate",
    email: "anna@example.com",
    invitation: "pending",
    can_approve: true,
  },
  notifications: { mode: "immediately" },
  timezone: null,
  critical_breakthrough: false,
  first_job: null,
  services: ["gmail"],
  unset: [],
} as unknown as Setup;

function notifications(setup: Setup, terminal: boolean, more = true) {
  return render(
    <NotificationsPanel
      n={notificationView(answersFromSetup(setup))}
      zone="Europe/Berlin"
      quietActive={false}
      device={{ bell: true, checked: false, disabled: false, note: "hint" }}
      onDevice={() => {}}
      terminal={terminal ? <span data-testid="terminal-row" /> : null}
      pause={<span data-testid="paused-row" />}
      pauseOptions={<span data-testid="pause-options-row" />}
      more={<span data-testid="engine-more" />}
      defaultMoreOpen={more}
      approvals="Mira"
      busy={false}
      error={null}
      saveError={null}
      onRetry={() => {}}
      onChange={() => {}}
    />,
  );
}

describe("Settings › Notifications", () => {
  test("quiet hours off show neither times nor days", () => {
    const html = notifications(stored, false);
    expect(html).toContain("Ruhezeiten");
    expect(html).not.toContain('data-testid="settings-notification-from"');
    expect(html).not.toContain('data-testid="settings-notification-days"');
    expect(html).not.toContain('data-testid="settings-notification-critical"');
    expect(html).toContain("Freigabe-Hinweise gehen an Mira.");
  });

  test("quiet hours on show from, until, days and critical breakthrough", () => {
    const html = notifications(
      {
        ...stored,
        notifications: { mode: "working_hours", from: "08:00", to: "18:00", days: [1, 2] },
      },
      false,
    );
    expect(html).toMatch(/data-testid="settings-notification-from" value="18:00"/);
    expect(html).toMatch(/data-testid="settings-notification-until" value="08:00"/);
    expect(html).toContain('data-testid="settings-notification-days"');
    expect(html).toContain('data-testid="settings-notification-critical"');
  });

  test("the panel shows the click-dummy's rows, everything else waits behind more options", () => {
    const quiet = {
      ...stored,
      notifications: { mode: "working_hours", from: "08:00", to: "18:00", days: [1, 2] },
    } as Setup;
    const html = notifications(quiet, true, false);
    expect(html).toContain(">Benachrichtigungen<");
    expect(html).toContain("Systembenachrichtigungen für Runs, Freigaben und Connector-Probleme.");
    expect(html).toContain('data-testid="paused-row"');
    expect(html).toContain('data-testid="settings-notification-from"');
    expect(html).toContain('data-testid="settings-notification-daily"');
    expect(html).toContain('data-testid="settings-notification-more-toggle"');
    expect(html).toContain(">Weitere Optionen<");
    for (const hidden of [
      "pause-options-row",
      "settings-notification-days",
      "terminal-row",
      "settings-notification-critical",
      "settings-notification-zone",
      "engine-more",
    ])
      expect(html).not.toContain(`data-testid="${hidden}"`);
    const open = notifications(quiet, true, true);
    for (const shown of ["pause-options-row", "terminal-row", "engine-more"])
      expect(open).toContain(`data-testid="${shown}"`);
  });

  test("with nothing behind more options the inner panel stays out of sight", () => {
    const html = render(
      <NotificationsPanel
        n={notificationView(answersFromSetup(stored))}
        zone="Europe/Berlin"
        quietActive={false}
        device={null}
        onDevice={() => {}}
        terminal={null}
        defaultMoreOpen
        approvals="Mira"
        busy={false}
        error={null}
        saveError={null}
        onRetry={() => {}}
        onChange={() => {}}
      />,
    );
    expect(html).toContain(
      'class="rounded-xl border bg-card p-6 text-card-foreground divide-y py-1 empty:hidden"></div>',
    );
  });

  test("the terminal quiet hours appear only when handed in", () => {
    expect(notifications(stored, false)).not.toContain("terminal-row");
    expect(notifications(stored, true)).toContain("terminal-row");
  });
});

describe("Settings › Setup", () => {
  const panel = (open: "notify" | null) =>
    render(
      <SetupSectionPanel
        setup={answersFromSetup(stored)}
        stored={stored}
        invitation={null}
        canSeePeople
        open={open}
        onOpen={() => {}}
        saving={false}
        saveError={null}
        onApply={() => {}}
      />,
    );

  test("every answer shows question, value and effect, the questions stay closed", () => {
    const html = panel(null);
    expect(html).toContain("Wann darf SubKit dich benachrichtigen?");
    expect(html).toContain('data-testid="settings-setup-value-services"');
    expect(html).not.toContain('data-testid="setup-notify"');
  });

  test("changing opens the question in place", () => {
    const html = panel("notify");
    expect(html).toContain('data-testid="setup-notify"');
    expect(html).toMatch(/aria-expanded="true"[^>]*data-testid="settings-setup-change-notify"/);
  });

  test("a named teammate shows the invitation state with a way to People", () => {
    const html = panel(null);
    expect(html).toContain('data-testid="settings-setup-approver-status"');
    expect(html).toContain('data-testid="settings-setup-open-people"');
  });
});

describe("Settings › Setup, approving together and sending invitations", () => {
  const pairStored = {
    ...stored,
    approver: {
      kind: "pair",
      email: "anna@example.com",
      user_id: "00000000-0000-4000-8000-0000000000aa",
      invite_id: null,
      invitation: "pending",
      can_approve: null,
      missing_permissions: [],
      pair: "needs_second_approver",
    },
  } as unknown as Setup;
  const panel = (setup: Setup, canInvite: boolean) =>
    render(
      <SetupSectionPanel
        setup={answersFromSetup(setup)}
        stored={setup}
        invitation={null}
        canSeePeople
        canInvite={canInvite}
        open={null}
        onOpen={() => {}}
        saving={false}
        saveError={null}
        onApply={() => {}}
      />,
    );

  test("the pair state reads as one line, with no second invitation line", () => {
    const html = panel(pairStored, false);
    expect(html).toContain('data-pair="needs_second_approver"');
    expect(html).toContain("Gemeinsam freigeben startet, sobald anna@example.com dabei ist");
    expect(html).not.toContain('data-testid="settings-setup-invitation"');
  });

  test("an administrator sends the prepared invitation from the approver line", () => {
    expect(panel(pairStored, true)).toContain('data-testid="settings-setup-invite-send"');
    expect(panel(pairStored, false)).not.toContain('data-testid="settings-setup-invite-send"');
  });
});

describe("Settings › Setup, workspace approval rule", () => {
  test("the refusal for a single approver shows only the counts", () => {
    const html = render(
      <ApprovalPolicyPanel
        policy={{
          workflow_approvals: "single",
          eligible_approvers: 1,
          ready: false,
          changed_at: null,
          changed_by: null,
        }}
        permissions={["rbac:write"]}
        busy={false}
        error={{
          status: 409,
          code: "pair_needs_two_approvers",
          details: { eligible_approvers: 1 },
        }}
        onChange={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('data-testid="settings-approval-policy-switch"');
    expect(html).toContain('data-testid="settings-approval-policy-failed"');
    expect(html).toContain("Gemeinsam freigeben braucht zwei Personen");
    expect(html).toContain('data-testid="settings-approval-policy-failed-technical-toggle"');
    expect(html).not.toContain('data-testid="settings-approval-policy-retry"');
  });
});

describe("Settings › Notifications, pause", () => {
  const control = (label: string | null): PauseControl => ({
    loaded: true,
    label,
    busy: false,
    error: null,
    pause: () => {},
    resume: () => {},
    retry: () => {},
  });

  test("without a pause the three options show", () => {
    const html = render(<PauseRow control={control(null)} />);
    for (const option of ["hour", "tomorrow", "resumed"])
      expect(html).toContain(`data-testid="settings-notification-pause-${option}"`);
    expect(html).toContain("Bis morgen 8:00 Uhr");
  });

  test("the panel shows the pause only while it holds, the options only while it does not", () => {
    expect(render(<PauseRow control={control(null)} when="paused" />)).toBe("");
    expect(render(<PauseRow control={control("Pausiert")} when="running" />)).toBe("");
    expect(render(<PauseRow control={control("Pausiert")} when="paused" />)).toContain(
      'data-testid="settings-notification-pause-resume"',
    );
    expect(render(<PauseRow control={control(null)} when="running" />)).toContain(
      'data-testid="settings-notification-pause-hour"',
    );
  });

  test("during a pause the state and resume show instead", () => {
    const html = render(<PauseRow control={control("Pausiert bis zum Fortsetzen")} />);
    expect(html).toContain("Pausiert bis zum Fortsetzen");
    expect(html).toContain('data-testid="settings-notification-pause-resume"');
    expect(html).not.toContain('data-testid="settings-notification-pause-hour"');
  });
});
