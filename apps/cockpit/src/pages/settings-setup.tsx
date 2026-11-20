import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { APPROVAL_RULES_KEY, listApprovalRules } from "@/api/approval-rules";
import { SETUP_KEY, type Setup, type SetupUpdate, useSetup, writeSetup } from "@/api/setup";
import { absolute, peopleHref, settingsHref } from "@/app/links";
import { useSession } from "@/app/session";
import { Button, DataState, ErrorNotice, StatusStrip } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { Question } from "./settings-guided";
import type { AreaCard } from "./settings-overview";
import { PreparedInvitation } from "./setup";
import {
  answersFromSetup,
  questionUpdate,
  SETUP_QUESTIONS,
  type SetupAnswers,
  type SetupQuestionId,
  scheduleNote,
  setupValue,
} from "./setup-model";
import { SetupQuestion } from "./setup-questions";

type Invitation = NonNullable<Setup["invitation"]>;

function ApproverStatus({ setup, invitation }: { setup: Setup; invitation: Invitation | null }) {
  const { t } = useI18n();
  const canSeePeople = useSession().permissions.includes("identity:read");
  if (setup.approver.kind !== "teammate")
    return (
      <p className="text-sm text-muted-foreground" data-testid="settings-setup-approvals-to">
        {t("setup.approvalsTo", { who: t("setup.you") })}
      </p>
    );
  const { email, invitation: state } = setup.approver;
  return (
    <div className="grid gap-3" data-testid="settings-setup-approver-status" data-state={state}>
      <p className="text-sm text-muted-foreground" data-testid="settings-setup-approvals-to">
        {t("setup.approvalsTo", { who: email })}
      </p>
      {invitation ? (
        <PreparedInvitation email={email} invitation={invitation} />
      ) : (
        <StatusStrip
          tone={state === "needs_admin" ? "warn" : state === "pending" ? "info" : "ok"}
          line={t(
            state === "needs_admin"
              ? "setup.needsAdmin"
              : state === "pending"
                ? "setup.pending"
                : "setup.member",
            { email },
          )}
          action={
            canSeePeople && state !== "member" ? (
              <Button asChild variant="outline" size="sm">
                <a href={absolute(peopleHref())} data-testid="settings-setup-open-people">
                  {t("setup.openPeople")}
                </a>
              </Button>
            ) : undefined
          }
          testId="settings-setup-invitation"
        />
      )}
      {setup.approver.can_approve === false ? (
        <StatusStrip
          tone="warn"
          line={t("setup.cannotApprove", { email })}
          action={
            canSeePeople ? (
              <Button asChild variant="outline" size="sm">
                <a href={absolute(peopleHref())} data-testid="settings-setup-approver-role">
                  {t("setup.openPeople")}
                </a>
              </Button>
            ) : undefined
          }
          testId="settings-setup-cannot-approve"
        />
      ) : null}
    </div>
  );
}

export function SetupArea() {
  const { t } = useI18n();
  const client = useQueryClient();
  const setup = useSetup();
  const [editing, setEditing] = useState<SetupQuestionId | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const save = useMutation({
    mutationFn: (body: SetupUpdate) => writeSetup(body),
    onSuccess: (stored) => {
      const { invitation: prepared, ...rest } = stored;
      client.setQueryData(SETUP_KEY, rest);
      setInvitation(prepared ?? null);
      setEditing(null);
      toast.success(t("setup.saved"));
    },
  });
  if (setup.isError)
    return (
      <ErrorNotice
        title={t("setup.loadFailed")}
        error={setup.error}
        remedy={{ label: t("pattern.retry"), onClick: () => void setup.refetch() }}
        testId="settings-setup-load-failed"
      />
    );
  if (!setup.data) return <DataState state="loading" testId="settings-setup-loading" />;
  const stored = setup.data;
  const answers: SetupAnswers = answersFromSetup(stored);
  return (
    <div className="grid gap-5" data-testid="settings-area-setup">
      <p className="text-sm text-muted-foreground" data-testid="settings-setup-lead">
        {t("setup.settingsLead")}
      </p>
      {save.isError ? (
        <ErrorNotice
          title={t("setup.saveFailed")}
          body={t("setup.saveFailedBody")}
          error={save.error}
          remedy={
            save.variables
              ? {
                  label: t("pattern.retry"),
                  variant: "primary",
                  size: "sm",
                  onClick: () => save.variables && save.mutate(save.variables),
                  testId: "settings-setup-save-retry",
                }
              : undefined
          }
          testId="settings-setup-save-failed"
        />
      ) : null}
      {SETUP_QUESTIONS.map((id) => (
        <Question
          key={id}
          title={t(`setup.label.${id}`)}
          help={t("setup.sets", { effect: t(`setup.effect.${id}`) })}
          aside={
            editing === id ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => setEditing(null)}
                data-testid={`settings-setup-cancel-${id}`}
              >
                {t("common.cancel")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={save.isPending}
                aria-label={t("setup.changeItem", { label: t(`setup.label.${id}`) })}
                onClick={() => {
                  save.reset();
                  setEditing(id);
                }}
                data-testid={`settings-setup-change-${id}`}
              >
                {t("setup.change")}
              </Button>
            )
          }
          testId={`settings-question-setup-${id}`}
        >
          {editing === id ? (
            <div className="grid gap-2">
              <p className="text-sm">{t(`setup.question.${id}`)}</p>
              <SetupQuestion
                id={id}
                value={answers}
                align="start"
                disabled={save.isPending}
                onDone={(next) => save.mutate(questionUpdate(id, next))}
              />
            </div>
          ) : (
            <p className="text-sm font-medium" data-testid={`settings-setup-value-${id}`}>
              {setupValue(id, answers, t)}
            </p>
          )}
          {id === "approver" && editing !== id ? (
            <ApproverStatus setup={stored} invitation={invitation} />
          ) : null}
        </Question>
      ))}
    </div>
  );
}

export function SetupScheduleNote() {
  const { t } = useI18n();
  const setup = useSetup();
  if (!setup.data) return null;
  const note = scheduleNote(setup.data, t);
  return (
    <StatusStrip
      tone="info"
      line={
        <span className="grid gap-0.5">
          <span data-testid="settings-notification-schedule-line">{note.line}</span>
          <span
            className="text-xs text-muted-foreground"
            data-testid="settings-notification-schedule-scope"
          >
            {note.detail}
          </span>
        </span>
      }
      action={
        <Button asChild variant="outline" size="sm">
          <a
            href={absolute(settingsHref(null, { area: "setup" }))}
            data-testid="settings-schedule-open-setup"
          >
            {t("setup.openSetup")}
          </a>
        </Button>
      }
      testId="settings-notification-schedule"
    />
  );
}

export function usePersonalAreaCards(): AreaCard[] {
  const { t, tn } = useI18n();
  const setup = useSetup();
  const rules = useQuery({
    queryKey: APPROVAL_RULES_KEY,
    queryFn: listApprovalRules,
    staleTime: 30_000,
    retry: false,
  });
  const active = (rules.data ?? []).filter((rule) => rule.state === "active").length;
  const offered = (rules.data ?? []).filter((rule) => rule.state === "offered").length;
  const activeLine =
    active === 0 ? t("settings.overview.rules.none") : tn("settings.overview.rules", active);
  return [
    {
      id: "setup",
      sentence: setup.data
        ? t("settings.overview.setup", {
            mode: t(`setup.mode.${setup.data.default_chat_mode}`),
            environment: t(`setup.env.${setup.data.default_environment}`),
            notify: t(`setup.notify.${setup.data.notifications.mode}`),
          })
        : t("settings.area.setup.purpose"),
      status: null,
    },
    {
      id: "rules",
      sentence:
        offered > 0
          ? t("settings.overview.rules.offered", { rules: activeLine, count: offered })
          : rules.data
            ? activeLine
            : rules.isPending
              ? t("common.loading")
              : t("settings.area.rules.purpose"),
      status: null,
    },
  ];
}
