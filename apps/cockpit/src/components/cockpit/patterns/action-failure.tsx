import { Button } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type ActionFailure,
  clearFailure,
  type FailureHostLevel,
  failureSnapshot,
  registerFailureHost,
  subscribeFailure,
} from "@/lib/action-failure";
import { failureFacts, failureRemedy } from "@/lib/failure-remedy";
import type { Translate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { REMEDY_LABEL } from "@/lib/remedy";
import type { ActionSpec } from "./action-button";
import { renderAction } from "./action-button";
import { type RemedyHref, useRemedyHref } from "./remedy-links";
import { useErrorNotice } from "./use-error-detail";

export function failureRemedyAction(
  input: { title: string; error?: unknown; retry?: () => void; testId?: string },
  t: Translate,
  remedyHref: RemedyHref,
): ActionSpec | undefined {
  const facts = failureFacts(input.error);
  const kind = failureRemedy(facts);
  if (kind === null) return undefined;
  const base = {
    variant: "primary" as const,
    size: "sm" as const,
    testId: input.testId ?? "action-failure-remedy",
    data: { "data-remedy": kind } as const,
  };
  if (kind === "retry")
    return input.retry
      ? { ...base, label: t(REMEDY_LABEL.retry), onClick: input.retry }
      : undefined;
  const href = remedyHref(
    kind,
    facts,
    t("remedy.failurePrompt", { failure: input.title, code: facts.code ?? "–" }),
  );
  return href === null ? undefined : { ...base, label: t(REMEDY_LABEL[kind]), href };
}

function hostRemedy(
  failure: ActionFailure | null,
  t: Translate,
  remedyHref: RemedyHref,
): ActionSpec | undefined {
  if (!failure) return undefined;
  if (failure.action)
    return {
      variant: "primary",
      size: "sm",
      testId: "action-failure-remedy",
      label: failure.action.label,
      onClick: failure.action.onClick,
    };
  const retry = failure.retry;
  return failureRemedyAction(
    {
      title: failure.title,
      error: failure.error,
      ...(retry
        ? {
            retry: () => {
              clearFailure();
              retry();
            },
          }
        : {}),
    },
    t,
    remedyHref,
  );
}

export function ActionFailureHost({
  className,
  level = "overlay",
  scope,
  remedyHref,
}: {
  className?: string;
  level?: FailureHostLevel;
  scope?: string;
  /** Where remedies lead; defaults to the links the app provides via RemedyLinksProvider. */
  remedyHref?: RemedyHref;
}) {
  const { t } = useI18n();
  const provided = useRemedyHref();
  const [host, setHost] = useState<number | null>(null);
  const snapshot = useSyncExternalStore(subscribeFailure, failureSnapshot, failureSnapshot);
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const registered = registerFailureHost(level, scope ?? null);
    setHost(registered.id);
    return registered.release;
  }, [level, scope]);
  const failure = host !== null && snapshot.host === host ? snapshot.failure : null;
  const shown = failure?.id ?? null;
  const remedy = hostRemedy(failure, t, remedyHref ?? provided);
  const notice = useErrorNotice({ error: failure?.error, body: failure?.body });
  useEffect(() => {
    if (shown !== null) node.current?.scrollIntoView?.({ block: "nearest" });
  }, [shown]);
  if (!failure) return null;
  return (
    <div
      ref={node}
      className={cn("min-w-0", className)}
      data-slot="action-failure"
      data-failure-level={level}
      data-failure-scope={scope}
    >
      <ErrorNotice
        key={failure.id}
        {...notice}
        testId="action-failure"
        title={failure.title}
        actions={
          <>
            {remedy ? renderAction(remedy) : null}

            <Button
              type="button"
              variant={remedy ? "ghost" : "outline"}
              size="sm"
              data-testid="action-failure-dismiss"
              onClick={clearFailure}
            >
              {t("common.close")}
            </Button>
          </>
        }
      />
    </div>
  );
}
