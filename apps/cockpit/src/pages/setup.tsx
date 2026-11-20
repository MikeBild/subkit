import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SETUP_KEY, type Setup, type SetupUpdate, writeSetup } from "@/api/setup";
import {
  Bubble,
  BubbleContent,
  Button,
  CopyField,
  ErrorNotice,
  IconTile,
  SectionHeading,
  StandalonePage,
} from "@/components/cockpit/patterns";
import { SubKitMark } from "@/components/cockpit/service-icon";
import { useI18n } from "@/lib/i18n-context";
import { inviteLink } from "./invite-model";
import {
  answersFromSetup,
  recommendedUpdate,
  SETUP_QUESTIONS,
  type SetupAnswers,
  type SetupQuestionId,
  setupUpdate,
  setupValue,
} from "./setup-model";
import { SETUP_ICON, SetupQuestion } from "./setup-questions";

function Asked({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      <SubKitMark size="sm" />
      <p className="min-w-0 pt-1 text-sm leading-5">{children}</p>
    </div>
  );
}

type Invitation = NonNullable<Setup["invitation"]>;

export function PreparedInvitation({
  email,
  invitation,
}: {
  email: string;
  invitation: Invitation;
}) {
  const { t, dateTime } = useI18n();
  return (
    <div className="grid gap-2" data-testid="setup-invitation">
      <p className="text-sm font-medium">{t("setup.prepared")}</p>
      <p className="text-sm text-muted-foreground">
        {t("setup.preparedBody", { email, time: dateTime(invitation.expires_at) })}
      </p>
      <CopyField
        value={inviteLink(window.location.origin, invitation.plaintext_token)}
        label={t("setup.preparedLink")}
        testId="setup-invitation-link"
      />
    </div>
  );
}

export function SetupStep({
  setup,
  onDone,
  onLater,
}: {
  setup: Setup;
  onDone(): void;
  onLater(): void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [answers, setAnswers] = useState<SetupAnswers>(() => answersFromSetup(setup));
  const [answered, setAnswered] = useState(0);
  const [editing, setEditing] = useState<SetupQuestionId | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const complete = answered >= SETUP_QUESTIONS.length && !editing;
  const position = `${answered}-${editing ?? ""}`;
  useEffect(() => {
    if (position !== "0-") end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [position]);
  const save = useMutation({
    mutationFn: (body: SetupUpdate) => writeSetup(body),
    onSuccess: (stored) => {
      const { invitation: prepared, ...rest } = stored;
      client.setQueryData(SETUP_KEY, rest);
      if (prepared) setInvitation(prepared);
      else onDone();
    },
  });
  const later = useMutation({
    mutationFn: () => writeSetup(recommendedUpdate(setup)),
    onSuccess: (stored) => {
      client.setQueryData(SETUP_KEY, stored);
      onLater();
    },
  });
  const busy = save.isPending || later.isPending;
  const current = editing ?? SETUP_QUESTIONS[answered];
  const answer = (next: SetupAnswers) => {
    setAnswers(next);
    if (editing) setEditing(null);
    else setAnswered((count) => count + 1);
  };

  if (invitation)
    return (
      <StandalonePage title={t("setup.step")} testId="setup-page">
        <PreparedInvitation email={answers.approverEmail.trim()} invitation={invitation} />
        <Button
          className="w-full sm:w-auto sm:self-start"
          onClick={onDone}
          data-testid="setup-continue"
        >
          {t("setup.continue")}
        </Button>
      </StandalonePage>
    );

  return (
    <StandalonePage title={t("setup.step")} testId="setup-page">
      <div
        className="flex flex-col gap-4"
        role="log"
        aria-live="polite"
        aria-label={t("setup.step")}
        data-testid="setup-conversation"
      >
        <Asked testId="setup-intro">{t("setup.intro")}</Asked>
        {SETUP_QUESTIONS.slice(0, answered)
          .filter((id) => id !== editing)
          .map((id) => (
            <div key={id} className="flex flex-col gap-2" data-testid={`setup-answered-${id}`}>
              <Asked>{t(`setup.question.${id}`)}</Asked>
              <Bubble variant="question" align="end">
                <BubbleContent data-testid={`setup-answer-${id}`}>
                  {setupValue(id, answers, t)}
                </BubbleContent>
              </Bubble>
              <p
                className="text-right text-xs text-muted-foreground"
                data-testid={`setup-effect-${id}`}
              >
                {t("setup.sets", { effect: t(`setup.effect.${id}`) })}
              </p>
            </div>
          ))}
        {current && !complete ? (
          <div className="flex flex-col gap-3" data-testid="setup-current">
            <Asked>{t(`setup.question.${current}`)}</Asked>
            <SetupQuestion
              key={current}
              id={current}
              value={answers}
              onDone={answer}
              disabled={busy}
            />
          </div>
        ) : null}
        {complete ? (
          <section
            aria-labelledby="setup-summary-title"
            className="rounded-xl border p-4"
            data-testid="setup-summary"
          >
            <SectionHeading id="setup-summary-title" className="text-base font-semibold">
              {t("setup.summaryTitle")}
            </SectionHeading>
            <ul className="mt-2 divide-y">
              {SETUP_QUESTIONS.map((id) => {
                const Icon = SETUP_ICON[id];
                return (
                  <li key={id} className="flex min-h-12 items-center gap-3 py-2 text-sm">
                    <IconTile size="sm">
                      <Icon />
                    </IconTile>
                    <span className="grid min-w-0 flex-1">
                      <span className="text-xs text-muted-foreground">
                        {t(`setup.label.${id}`)}
                      </span>
                      <span className="truncate" data-testid={`setup-summary-${id}`}>
                        {setupValue(id, answers, t)}
                      </span>
                    </span>
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      disabled={save.isPending}
                      aria-label={t("setup.changeItem", { label: t(`setup.label.${id}`) })}
                      onClick={() => setEditing(id)}
                      data-testid={`setup-change-${id}`}
                    >
                      {t("setup.change")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {save.isError ? (
          <ErrorNotice
            title={t("setup.saveFailed")}
            body={t("setup.saveFailedBody")}
            error={save.error}
            remedy={{
              label: t("pattern.retry"),
              variant: "primary",
              size: "sm",
              onClick: () => save.mutate(setupUpdate(answers)),
              testId: "setup-save-retry",
            }}
            testId="setup-save-failed"
          />
        ) : null}
        {later.isError ? (
          <ErrorNotice
            title={t("setup.laterFailed")}
            body={t("setup.laterFailedBody")}
            error={later.error}
            remedy={{
              label: t("pattern.retry"),
              variant: "primary",
              size: "sm",
              onClick: () => later.mutate(),
              testId: "setup-later-retry",
            }}
            secondary={
              <Button variant="ghost" size="sm" onClick={onLater} data-testid="setup-later-anyway">
                {t("setup.laterAnyway")}
              </Button>
            }
            testId="setup-later-failed"
          />
        ) : null}
        <div ref={end} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            disabled={save.isPending}
            pending={later.isPending}
            onClick={() => {
              save.reset();
              later.mutate();
            }}
            data-testid="setup-skip"
          >
            {t("setup.skip")}
          </Button>
          <Button
            disabled={!complete || later.isPending}
            pending={save.isPending}
            onClick={() => {
              later.reset();
              save.mutate(setupUpdate(answers));
            }}
            data-testid="setup-accept"
          >
            {t("setup.accept")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="setup-skip-hint">
          {t("setup.skipHint")}
        </p>
      </div>
    </StandalonePage>
  );
}
