import { useEffect, useState } from "react";
import { contextualHref } from "@/app/installation-context";
import { Button, ChatCard, ContextHelp, Spinner } from "@/components/cockpit/patterns";
import { WorkflowReview } from "@/components/cockpit/workflow-review";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { approvalLine, type ChatApproval } from "./chat-approval";

export function ChatApprovalCard({
  approval,
  busy,
  error,
  onDecision,
  testId,
  conversationId,
}: {
  approval: ChatApproval;
  busy: boolean;
  error: boolean;
  onDecision: (id: string, approved: boolean) => void;
  testId: string;
  conversationId?: string;
}) {
  const { t, locale } = useI18n();
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewable = approval.savesInactiveWorkflow && Boolean(conversationId);
  const deadline = Date.parse(approval.expiresAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const readable = (value: string) =>
    hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
  const title = t(
    approval.oauth
      ? "chat.reauth.title"
      : approval.singleRun
        ? "chat.singleRun.title"
        : approval.savesInactiveWorkflow
          ? "chat.decision.saveTitle"
          : "chat.decision.title",
  );
  const line = approvalLine(approval, t, readable);
  const details = approval.description ?? (approval.singleRun ? approval.question : null);
  return (
    <>
      <ChatCard
        testId={testId}
        title={
          <span className="flex items-center gap-1">
            {title}
            {details ? (
              <ContextHelp label={t("chat.decision.details")} testId={`${testId}-details`}>
                {readable(details)}
              </ContextHelp>
            ) : null}
          </span>
        }
        line={line}
        secondary={
          <Button
            variant="outline"
            disabled={busy || expired}
            onClick={() => onDecision(approval.id, false)}
            data-testid={`${testId}-decline`}
          >
            {t("chat.approval.decline")}
          </Button>
        }
        action={
          <Button
            disabled={
              busy || expired || (approval.oauth === "complete" && !approval.authorizationUrl)
            }
            onClick={() => (reviewable ? setReviewOpen(true) : onDecision(approval.id, true))}
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
                      ? reviewable
                        ? "reviewWorkflow.open"
                        : "chat.decision.save"
                      : "chat.approval.approve",
            )}
          </Button>
        }
      >
        {approval.authorizationUrl && !expired && (
          <Button asChild variant="outline" className="w-fit">
            <a
              href={contextualHref(approval.authorizationUrl)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`${testId}-sign-in`}
            >
              {t("chat.oauth.signIn")}
            </a>
          </Button>
        )}
        {approval.subjects && approval.subjects.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid={`${testId}-subjects`}>
            {approval.subjects.map((subject) => (
              <li key={subject}>{readable(subject)}</li>
            ))}
          </ul>
        )}
        {approval.externalTool?.server_claim && (
          <p className="text-sm text-muted-foreground" data-testid={`${testId}-server-claim`}>
            {t("chat.decision.serverClaim", {
              claim: readable(approval.externalTool.server_claim),
            })}
          </p>
        )}
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-deadline`}>
          {expired
            ? t("chat.decision.expired")
            : `${t("chat.decision.validUntil")} ${formatDateTime(locale, approval.expiresAt)}`}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid={`${testId}-error`}>
            {t("chat.decision.failed")}
          </p>
        )}
      </ChatCard>
      {reviewable && conversationId && (
        <WorkflowReview
          key={`${conversationId}:${approval.id}`}
          conversationId={conversationId}
          elicitationId={approval.id}
          open={reviewOpen}
          onOpenChange={setReviewOpen}
        />
      )}
    </>
  );
}
