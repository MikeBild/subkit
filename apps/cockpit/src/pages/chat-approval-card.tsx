import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import type { ChatApproval } from "./chat-approval";

export function ChatApprovalCard({
  approval,
  busy,
  error,
  onDecision,
  testId,
}: {
  approval: ChatApproval;
  busy: boolean;
  error: boolean;
  onDecision: (id: string, approved: boolean) => void;
  testId: string;
}) {
  const { t, locale } = useI18n();
  const deadline = Date.parse(approval.expiresAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const readable = (value: string) =>
    hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
  return (
    <Card size="sm" tone="question" data-testid={testId}>
      <CardHeader>
        <CardTitle>
          {t(
            approval.oauth
              ? "chat.reauth.title"
              : approval.singleRun
                ? "chat.singleRun.title"
                : approval.savesInactiveWorkflow
                  ? "chat.decision.saveTitle"
                  : "chat.decision.title",
          )}
        </CardTitle>
        <CardDescription>
          {approval.oauth
            ? t(approval.oauth === "start" ? "chat.oauth.startHelp" : "chat.oauth.completeHelp")
            : approval.singleRun
              ? t("chat.singleRun.effect", {
                  name: approval.workflowName ?? t("chat.singleRun.thisWorkflow"),
                })
              : approval.externalTool
                ? t("chat.decision.externalTool", {
                    connector: approval.externalTool.connector,
                    tool: approval.externalTool.tool,
                  })
                : readable(approval.question)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {approval.authorizationUrl && !expired && (
          <Button asChild>
            <a
              href={approval.authorizationUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`${testId}-sign-in`}
            >
              {t("chat.oauth.signIn")}
            </a>
          </Button>
        )}
        {approval.savesInactiveWorkflow && <p>{t("chat.decision.saveEffect")}</p>}
        {approval.externalTool?.hint && (
          <p className="text-sm text-muted-foreground" data-testid={`${testId}-hint`}>
            {readable(approval.externalTool.hint)}
          </p>
        )}
        {(approval.description || approval.singleRun) && (
          <details>
            <summary className="cursor-pointer">{t("chat.decision.details")}</summary>
            <p className="mt-2 text-sm text-muted-foreground">
              {readable(approval.description ?? approval.question)}
            </p>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          {expired
            ? t("chat.decision.expired")
            : `${t("chat.decision.validUntil")} ${formatDateTime(locale, approval.expiresAt)}`}
        </p>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{t("chat.decision.failed")}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || expired}
          onClick={() => onDecision(approval.id, false)}
          data-testid={`${testId}-decline`}
        >
          {t("chat.approval.decline")}
        </Button>
        <Button
          disabled={
            busy || expired || (approval.oauth === "complete" && !approval.authorizationUrl)
          }
          onClick={() => onDecision(approval.id, true)}
          data-testid={`${testId}-approve`}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {t(
            busy
              ? "chat.decision.processing"
              : approval.oauth
                ? approval.oauth === "start"
                  ? "chat.oauth.start"
                  : "chat.oauth.check"
                : approval.singleRun
                  ? "chat.singleRun.confirm"
                  : approval.savesInactiveWorkflow
                    ? "chat.decision.save"
                    : "chat.approval.approve",
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
