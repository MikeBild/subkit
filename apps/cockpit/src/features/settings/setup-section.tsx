import { IconTile } from "@ui/atoms/icon-tile";
import { Panel } from "@ui/atoms/pill";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { StatusStrip } from "@ui/molecules/status-strip";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { Setup } from "@/api/setup";
import { absolute, peopleHref, settingsHref } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, DataState } from "@/components/cockpit/patterns";
import { InviteLinkDialog, useInviteSend } from "@/features/admin";
import {
  type Invitation,
  PreparedInvitation,
  pairLine,
  SETUP_ICON,
  SETUP_KEYS,
  type SetupAnswers,
  type SetupKey,
  SetupQuestion,
  setupValue,
  usePairOption,
  useSetupSettings,
} from "@/features/setup";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import { ApprovalPolicyRow } from "./approval-policy";

function ApproverStatus({
  setup,
  invitation,
  canSeePeople,
  canInvite,
  onSend,
  sending,
}: {
  setup: Setup;
  invitation: Invitation | null;
  canSeePeople: boolean;
  canInvite: boolean;
  onSend: (id: string, email: string) => void;
  sending: boolean;
}) {
  const { t } = useI18n();
  if (setup.approver.kind === "self") return null;
  const { email, invitation: state, user_id } = setup.approver;
  const pair = pairLine(setup.approver, t);
  const people = (testId: string) =>
    canSeePeople ? (
      <Button asChild variant="outline" size="sm">
        <a href={absolute(peopleHref())} data-testid={testId}>
          {t("setup.openPeople")}
        </a>
      </Button>
    ) : undefined;
  const send =
    state === "pending" && canInvite && user_id ? (
      <Button
        variant="outline"
        size="sm"
        disabled={sending}
        onClick={() => onSend(user_id, email)}
        data-testid="settings-setup-invite-send"
      >
        {t("people.invite.send")}
      </Button>
    ) : undefined;
  const action = state === "member" ? undefined : (send ?? people("settings-setup-open-people"));
  return (
    <div
      className="mt-3 flex flex-col gap-3 pl-12"
      data-testid="settings-setup-approver-status"
      data-state={state}
    >
      {invitation ? (
        <PreparedInvitation email={email} invitation={invitation} />
      ) : pair ? (
        <div data-testid="settings-setup-pair" data-pair={pair.state}>
          <StatusStrip className="mb-0" tone={pair.tone} action={action}>
            {pair.text}
          </StatusStrip>
        </div>
      ) : (
        <div data-testid="settings-setup-invitation">
          <StatusStrip
            className="mb-0"
            tone={state === "needs_admin" ? "warning" : state === "pending" ? "info" : "success"}
            action={action}
          >
            {t(
              state === "needs_admin"
                ? "setup.needsAdmin"
                : state === "pending"
                  ? "setup.pending"
                  : "setup.member",
              { email },
            )}
          </StatusStrip>
        </div>
      )}
      {setup.approver.can_approve === false && (
        <div data-testid="settings-setup-cannot-approve">
          <StatusStrip
            className="mb-0"
            tone="warning"
            action={people("settings-setup-approver-role")}
          >
            {t("setup.cannotApprove", { email })}
          </StatusStrip>
        </div>
      )}
    </div>
  );
}

export function SetupSection() {
  const { t } = useI18n();
  const a = useSetupSettings();
  const offerPair = usePairOption(a.stored);
  const permissions = useSession().permissions;
  const canSeePeople = permissions.includes("identity:read");
  const invite = useInviteSend();
  const [open, setOpen] = useState<SetupKey | null>(null);
  if (a.query.isError)
    return (
      <ErrorNotice
        testId="settings-setup-load-failed"
        kind="setupNotLoaded"
        title={t("setup.loadFailed")}
        body={t("setup.loadFailedBody")}
        primary={{ label: t("pattern.retry"), onClick: () => void a.query.refetch() }}
        rows={errorRows(a.query.error, t)}
      />
    );
  if (!a.stored || !a.setup) return <DataState state="loading" testId="settings-setup-loading" />;
  return (
    <>
      <SetupSectionPanel
        setup={a.setup}
        stored={a.stored}
        invitation={a.invitation}
        canSeePeople={canSeePeople}
        canInvite={permissions.includes("identity:write")}
        canSeeUsage={permissions.includes("stats:read")}
        onSend={invite.send}
        sending={invite.pending}
        policy={<ApprovalPolicyRow />}
        offerPair={offerPair}
        open={open}
        onOpen={(k) => {
          a.reset();
          setOpen(k);
        }}
        saving={a.saving}
        saveError={a.saveError}
        retry={a.retry}
        onApply={(k, v) =>
          a.applyAnswer(k, v, () => {
            setOpen(null);
            toast.success(t("setup.saved"));
          })
        }
      />
      <InviteLinkDialog invite={invite.link} onClose={invite.closeLink} />
    </>
  );
}

export function SetupSectionPanel({
  setup,
  stored,
  invitation,
  canSeePeople,
  canInvite = false,
  canSeeUsage = false,
  onSend = () => {},
  sending = false,
  policy,
  offerPair = false,
  open,
  onOpen,
  saving,
  saveError,
  retry,
  onApply,
}: {
  setup: SetupAnswers;
  stored: Setup;
  invitation: Invitation | null;
  canSeePeople: boolean;
  canInvite?: boolean;
  canSeeUsage?: boolean;
  onSend?: (id: string, email: string) => void;
  sending?: boolean;
  policy?: ReactNode;
  offerPair?: boolean;
  open: SetupKey | null;
  onOpen: (k: SetupKey | null) => void;
  saving: boolean;
  saveError: unknown;
  retry?: (() => void) | undefined;
  onApply: (k: SetupKey, v: SetupAnswers) => void;
}) {
  const { t } = useI18n();
  const s = { setup, stored };
  const a = { saving, saveError, retry, invitation };
  return (
    <div className="flex flex-col gap-4" data-testid="settings-area-setup">
      {a.saveError ? (
        <ErrorNotice
          testId="settings-setup-save-failed"
          kind="settingNotSaved"
          title={t("setup.saveFailed")}
          body={t("setup.saveFailedBody")}
          primary={
            a.retry
              ? { label: t("pattern.retry"), onClick: a.retry, testId: "settings-setup-save-retry" }
              : undefined
          }
          rows={errorRows(a.saveError, t)}
        />
      ) : null}
      <Panel className="divide-y py-1">
        {SETUP_KEYS.map((k) => (
          <div key={k} className="py-3" data-testid={`settings-question-setup-${k}`}>
            <div className="flex items-center gap-3">
              <IconTile icon={SETUP_ICON[k]} size="md" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{t(`setup.question.${k}`)}</p>
                <p className="truncate text-sm" data-testid={`settings-setup-value-${k}`}>
                  {setupValue(k, s.setup, t)}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`settings-setup-effect-${k}`}
                >
                  {t("setup.sets", { effect: t(`setup.effect.${k}`) })}
                </p>
              </div>
              {k === "budget" && !canSeeUsage ? null : k === "budget" ? (
                <Button asChild size="sm" variant="outline">
                  <a
                    href={absolute(settingsHref(null, { area: "usage" }))}
                    data-testid="settings-setup-open-usage"
                  >
                    {t("setup.openUsage")}
                  </a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  aria-expanded={open === k}
                  disabled={a.saving}
                  aria-label={t("setup.changeItem", { label: t(`setup.label.${k}`) })}
                  onClick={() => onOpen(open === k ? null : k)}
                  data-testid={`settings-setup-change-${k}`}
                >
                  {t("setup.change")}
                </Button>
              )}
            </div>
            {open === k && (
              <div className="mt-3 pl-12">
                <SetupQuestion
                  k={k}
                  value={s.setup}
                  align="start"
                  disabled={a.saving}
                  offerPair={offerPair}
                  onDone={(v) => onApply(k, v)}
                />
              </div>
            )}
            {k === "approver" && open !== k && (
              <ApproverStatus
                setup={s.stored}
                invitation={a.invitation}
                canSeePeople={canSeePeople}
                canInvite={canInvite}
                onSend={onSend}
                sending={sending}
              />
            )}
            {k === "approver" && policy}
          </div>
        ))}
      </Panel>
    </div>
  );
}
