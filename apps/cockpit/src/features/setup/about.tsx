import { IconTile } from "@ui/atoms/icon-tile";
import { ChatBubble as Bubble } from "@ui/molecules/chat-bubble";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { useEffect, useRef, useState } from "react";
import type { Setup } from "@/api/setup";
import { Button, SectionHeading, StandalonePage } from "@/components/cockpit/patterns";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import { PreparedInvitation } from "./invitation";
import { type SetupAnswers, setupKeys, setupValue } from "./model/setup-model";
import { SETUP_ICON, type SetupKey, SetupQuestion } from "./setup-question";
import { usePairOption, useSetupFlow } from "./use-setup";

export function About({
  setup: stored,
  onDone,
  onLater,
}: {
  setup: Setup;
  onDone(): void;
  onLater(): void;
}) {
  const { t } = useI18n();
  const a = useSetupFlow(stored, { onDone, onLater });
  const offerPair = usePairOption(stored);
  const [setup, setSetup] = useState<SetupAnswers>(a.setup);
  const keys = setupKeys(stored);
  const [answered, setAnswered] = useState(0);
  const [editing, setEditing] = useState<SetupKey | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const done = answered >= keys.length && !editing;
  const position = `${answered}-${editing ?? ""}`;
  useEffect(() => {
    if (position !== "0-") end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [position]);
  const busy = a.saving || a.skipping;
  const answer = (v: SetupAnswers) => {
    setSetup(v);
    if (editing) setEditing(null);
    else setAnswered(answered + 1);
  };
  const current = editing ?? keys[answered];

  if (a.invitation)
    return (
      <StandalonePage
        title={t("setup.step")}
        testId="setup-page"
        actions={{
          primary: (
            <Button onClick={onDone} data-testid="setup-continue">
              {t("setup.continue")}
            </Button>
          ),
        }}
      >
        <PreparedInvitation email={setup.approverEmail.trim()} invitation={a.invitation} />
      </StandalonePage>
    );

  return (
    <StandalonePage
      title={t("setup.step")}
      testId="setup-page"
      actions={{
        primary: (
          <>
            <Button
              variant="ghost"
              disabled={a.saving}
              pending={a.skipping}
              onClick={a.skip}
              data-testid="setup-skip"
            >
              {t("setup.skip")}
            </Button>
            <Button
              disabled={!done || a.skipping}
              pending={a.saving}
              onClick={() => a.applySetup(setup)}
              data-testid="setup-accept"
            >
              {t("setup.accept")}
            </Button>
          </>
        ),
      }}
    >
      <div
        role="log"
        aria-live="polite"
        aria-label={t("setup.step")}
        data-testid="setup-conversation"
      >
        <div data-testid="setup-intro">
          <Bubble>{t("setup.intro")}</Bubble>
        </div>
        {(done ? [] : keys.slice(0, answered))
          .filter((k) => k !== editing)
          .map((k) => (
            <div key={k} data-testid={`setup-answered-${k}`}>
              <Bubble continued>{t(`setup.question.${k}`)}</Bubble>
              <Bubble answer>
                <span data-testid={`setup-answer-${k}`}>{setupValue(k, setup, t)}</span>
              </Bubble>
            </div>
          ))}
        {current && !done && (
          <div data-testid="setup-current">
            <Bubble continued>{t(`setup.question.${current}`)}</Bubble>
            <div className="mb-3 mt-3">
              <SetupQuestion
                key={current}
                k={current}
                value={setup}
                onDone={answer}
                disabled={busy}
                offerPair={offerPair}
              />
            </div>
          </div>
        )}
        {done && (
          <section
            aria-labelledby="setup-summary-title"
            className="mb-3 mt-3 rounded-xl border p-4"
            data-testid="setup-summary"
          >
            <SectionHeading id="setup-summary-title" className="mb-2 font-semibold">
              {t("setup.summaryTitle")}
            </SectionHeading>
            <ul className="divide-y">
              {keys.map((k) => (
                <li key={k} className="flex min-h-12 items-center gap-3 py-2 text-sm">
                  <IconTile icon={SETUP_ICON[k]} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-muted-foreground">
                      {t(`setup.label.${k}`)}
                    </span>
                    <span className="block truncate" data-testid={`setup-summary-${k}`}>
                      {setupValue(k, setup, t)}
                    </span>
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto px-0"
                    disabled={a.saving}
                    aria-label={t("setup.changeItem", { label: t(`setup.label.${k}`) })}
                    onClick={() => setEditing(k)}
                    data-testid={`setup-change-${k}`}
                  >
                    {t("setup.change")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {a.saveError ? (
          <ErrorNotice
            testId="setup-save-failed"
            kind="settingNotSaved"
            title={t("setup.saveFailed")}
            body={t("setup.saveFailedBody")}
            primary={{
              label: t("pattern.retry"),
              onClick: () => a.applySetup(setup),
              testId: "setup-save-retry",
            }}
            rows={errorRows(a.saveError, t)}
          />
        ) : null}
        {a.skipError ? (
          <ErrorNotice
            testId="setup-later-failed"
            kind="settingNotSaved"
            title={t("setup.laterFailed")}
            body={t("setup.laterFailedBody")}
            primary={{ label: t("pattern.retry"), onClick: a.skip, testId: "setup-later-retry" }}
            secondary={{
              label: t("setup.laterAnyway"),
              onClick: onLater,
              testId: "setup-later-anyway",
            }}
            rows={errorRows(a.skipError, t)}
          />
        ) : null}
        <p className="ml-10 mt-4 text-xs text-muted-foreground" data-testid="setup-skip-hint">
          {t("setup.skipHint")}
        </p>
        <div ref={end} />
      </div>
    </StandalonePage>
  );
}
