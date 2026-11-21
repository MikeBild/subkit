import { useRouter } from "@tanstack/react-router";
import type { PageFailureSpec } from "@ui/lib/errors";
import { useUi } from "@ui/lib/ui-context";
import { type ReactNode, useState } from "react";
import { absolute } from "@/app/links";
import { errorSentence, labelledTechnicalRows, technicalKind } from "@/lib/error-facts";
import { useI18n } from "@/lib/i18n-context";

export interface ErrorDetail {
  kind: string;
  rows: [string, string][] | undefined;
  body: string;
  technical: boolean;
}

export function useErrorDetail(error: unknown): ErrorDetail {
  const { t } = useI18n();
  const { now } = useUi();
  const [at] = useState(() => new Date(now()));
  const known = error !== undefined && error !== null;
  return {
    kind: known ? technicalKind(error) : "unknown",
    rows: known ? labelledTechnicalRows(error, at, t) : undefined,
    body: errorSentence(error, t) ?? t("error.unchanged"),
    technical: known,
  };
}

export interface ErrorNoticeFacts {
  kind: string;
  rows: [string, string][] | undefined;
  technical: boolean;
  body: ReactNode;
  tone: "danger" | "warning";
}

export function useErrorNotice(input: {
  error?: unknown;
  body?: ReactNode;
  tone?: "error" | "warn";
}): ErrorNoticeFacts {
  const detail = useErrorDetail(input.error);
  return {
    kind: detail.kind,
    rows: detail.rows,
    technical: detail.technical,
    body: input.body ?? detail.body,
    tone: input.tone === "warn" ? "warning" : "danger",
  };
}

export interface PageFailureProps {
  onRetry: () => void;
  onHome: () => void;
  rows: [string, string][];
  testId: string;
  retryTestId: string | undefined;
}

export function usePageFailure(spec: PageFailureSpec | null): PageFailureProps | null {
  const router = useRouter({ warn: false });
  const { t } = useI18n();
  const { now } = useUi();
  const [at] = useState(() => new Date(now()));
  if (!spec) return null;
  return {
    onRetry: spec.onRetry,
    onHome: () => {
      const home = absolute("/");
      if (router) router.history.push(home);
      else window.location.assign(home);
    },
    rows: labelledTechnicalRows(spec.error, at, t),
    testId: spec.testId,
    retryTestId: spec.retryTestId,
  };
}
