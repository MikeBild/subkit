import { Button } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  absolute,
  attentionHref,
  chatNewHref,
  connectorHref,
  connectorsHref,
  peopleHref,
  workflowAutomationHref,
} from "@/app/links";
import { loginHref } from "@/app/login-href";
import {
  type ActionFailure,
  clearFailure,
  type FailureHostLevel,
  failureSnapshot,
  registerFailureHost,
  subscribeFailure,
} from "@/lib/action-failure";
import {
  type FailureFacts,
  type FailureRemedyKind,
  failureFacts,
  failureRemedy,
} from "@/lib/failure-remedy";
import type { Translate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { REMEDY_LABEL } from "@/lib/remedy";
import type { ActionSpec } from "./action-button";
import { renderAction } from "./action-button";
import { useErrorNotice } from "./use-error-detail";

export function failureRemedyHref(
  kind: Exclude<FailureRemedyKind, "retry">,
  facts: FailureFacts,
  prompt: string,
): string {
  switch (kind) {
    case "sign_in":
      return loginHref();
    case "reconnect":
      return absolute(
        facts.connectorId
          ? `${connectorHref(facts.connectorId)}#connector-credentials`
          : connectorsHref({ health: "not_ok" }),
      );
    case "grant":
      return absolute(
        facts.workflowId ? workflowAutomationHref(facts.workflowId) : attentionHref(),
      );
    case "chat":
      return absolute(
        chatNewHref({ prompt, workflowId: facts.workflowId, connectorId: facts.connectorId }),
      );
    case "admin":
      return absolute(peopleHref());
    case "new_conversation":
      return absolute(chatNewHref());
  }
}

export function failureRemedyAction(
  input: { title: string; error?: unknown; retry?: () => void; testId?: string },
  t: Translate,
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
  return {
    ...base,
    label: t(REMEDY_LABEL[kind]),
    href: failureRemedyHref(
      kind,
      facts,
      t("remedy.failurePrompt", { failure: input.title, code: facts.code ?? "–" }),
    ),
  };
}

function hostRemedy(failure: ActionFailure | null, t: Translate): ActionSpec | undefined {
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
  );
}

export function ActionFailureHost({
  className,
  level = "overlay",
  scope,
}: {
  className?: string;
  level?: FailureHostLevel;
  scope?: string;
}) {
  const { t } = useI18n();
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
  const remedy = hostRemedy(failure, t);
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
