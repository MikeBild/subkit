import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Input } from "@ui/atoms/input";
import { Label } from "@ui/atoms/label";
import { Skel } from "@ui/atoms/skeleton";
import { useLoadingPhase } from "@ui/lib/loading-phase";
import { BusyButton } from "@ui/molecules/busy-button";
import { ErrorNotice, FieldError } from "@ui/molecules/error-notice";
import { StatusStrip } from "@ui/molecules/status-strip";
import { StepFooter } from "@ui/molecules/step-footer";
import { Laptop, Server } from "lucide-react";
import { useState } from "react";
import { useSignIn } from "../../adapter/index.ts";
import type { Problem } from "../../domain/index.ts";
import { factRows } from "../../lib/text.ts";
import { adminMessage, problemCode } from "./connect-model.ts";
import { ConnectionOk, ConnectionProblem } from "./connection-result.tsx";
import { useConnect } from "./use-connect.ts";

function ProblemNotice({
  problem,
  onRetry,
  onExample,
}: {
  problem: Problem;
  onRetry: () => void;
  onExample: (address: string) => void;
}) {
  const { t } = useSignIn();
  const [asked, setAsked] = useState(false);
  const message = adminMessage(problem, t);
  const retry = { label: t("err.retry"), onClick: onRetry, testId: "connection-retry" };
  const { example } = problem;
  return (
    <div className="flex flex-col gap-2">
      <ConnectionProblem
        tone={problem.tone}
        code={problemCode(problem)}
        meta={problem.meta}
        title={t(problem.title, problem.vars)}
        body={t(problem.body, problem.vars)}
        rows={factRows(problem.facts, t)}
        primary={
          message
            ? {
                label: t("notice.ask"),
                testId: "connect-ask-admin",
                onClick: () => {
                  void navigator.clipboard
                    ?.writeText(message)
                    .then(() => setAsked(true))
                    .catch(() => setAsked(false));
                },
              }
            : retry
        }
        secondary={
          message
            ? retry
            : example
              ? {
                  label: t("connect.useExample"),
                  testId: "connect-use-example",
                  onClick: () => onExample(example),
                }
              : null
        }
      />
      {message && (
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {asked ? t("notice.asked") : null}
        </p>
      )}
    </div>
  );
}

export function Connect() {
  const { s, a } = useConnect();
  const { t } = useSignIn();
  const phase = useLoadingPhase(s.checking);
  const { strip, slot } = s;
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("connect.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("connect.lead")}</p>
      {s.localMacOnly && (
        <p data-testid="connect-local-mac-only" className="mt-2 text-sm text-muted-foreground">
          {t("workspace.local.macOnly")}
        </p>
      )}
      {s.localAvailable && (
        <div className="my-4 flex flex-col gap-2">
          <Button
            data-testid="connect-choice-server"
            variant="secondary"
            aria-pressed="true"
            className="h-auto w-full justify-start whitespace-normal p-4 text-left"
          >
            <IconTile icon={Server} size="md" />
            {t("workspace.choice.server")}
          </Button>
          <Button
            data-testid="connect-choice-local"
            variant="outline"
            aria-pressed="false"
            className="h-auto w-full justify-start whitespace-normal p-4 text-left"
            onClick={a.startLocal}
          >
            <IconTile icon={Laptop} size="md" />
            {t("workspace.choice.local")}
          </Button>
        </div>
      )}
      {strip?.body ? (
        <ErrorNotice
          className="mt-3"
          tone="warning"
          kind="installation_revoked"
          title={t(strip.title, strip.vars)}
          body={t(strip.body)}
          rows={factRows(strip.facts ?? [], t)}
          testId="connect-notice"
          primary={
            strip.action
              ? {
                  label: t(strip.action.label),
                  onClick: () => strip.action && a.act(strip.action.action),
                  testId: "connect-notice-action",
                }
              : undefined
          }
        />
      ) : strip ? (
        <StatusStrip
          tone={strip.tone}
          className="mt-3 mb-0"
          action={
            strip.action && (
              <Button
                data-testid="connect-notice-action"
                size="sm"
                variant="outline"
                onClick={() => strip.action && a.act(strip.action.action)}
              >
                {t(strip.action.label)}
              </Button>
            )
          }
        >
          {t(strip.title, strip.vars)}
        </StatusStrip>
      ) : null}
      <form
        className="mt-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          a.check(s.address);
        }}
      >
        <Label htmlFor="server-url">{t("connect.address.label")}</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          <Input
            data-testid="connect-address"
            id="server-url"
            className="min-w-0 flex-1 font-mono"
            value={s.address}
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={s.fieldError !== null}
            aria-describedby={s.fieldError ? "server-url-error" : undefined}
            onChange={(e) => a.setUrl(e.target.value)}
          />
          <BusyButton
            data-testid="connect-check"
            type="submit"
            busy={s.checking}
            busyLabel={t("connect.checking")}
          >
            {t("connect.check")}
          </BusyButton>
        </div>
        {s.fieldError && (
          <FieldError id="server-url-error" testId="connect-address-error">
            {t(s.fieldError, { example: t("connect.ownServer.example") })}
          </FieldError>
        )}
        <p data-testid="connect-own-server" className="mt-2 text-xs text-muted-foreground">
          {t("connect.ownServer", { example: t("connect.ownServer.example") })}
        </p>
        {s.examples.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("connect.examples")}</span>
            {s.examples.map((u) => (
              <Button
                data-testid={`connect-example-${u}`}
                key={u}
                variant="outline"
                size="sm"
                type="button"
                onClick={() => a.check(u)}
                className="h-6 max-w-full break-all whitespace-normal rounded-full px-2 font-mono text-xs"
              >
                {u}
              </Button>
            ))}
          </div>
        )}
      </form>

      <div className="mt-2" aria-live="polite" aria-busy={s.checking}>
        {slot.kind === "checking" || phase !== "content" ? (
          <div className="h-[86px]">{phase === "skeleton" && <Skel.Connection />}</div>
        ) : slot.outcome.kind === "idle" ? (
          <div aria-hidden className="h-[86px] rounded-xl border border-dashed" />
        ) : slot.outcome.kind === "ok" ? (
          <ConnectionOk
            title={t("slot.ok")}
            chip={
              slot.outcome.version ? t("chip.version", { version: slot.outcome.version }) : null
            }
          />
        ) : (
          <ProblemNotice
            problem={slot.outcome.problem}
            onRetry={() => a.act({ kind: "recheck" })}
            onExample={a.check}
          />
        )}
      </div>
      <StepFooter
        disabled={!s.canContinue}
        next={a.next}
        back={a.back}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
