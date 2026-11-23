import { formatBytes } from "@shared/file-kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { ToolApprovalCard } from "@ui/organisms/tool-approval-card";
import { Clock, KeyRound, Laptop, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { listDevices } from "@/api/devices";
import { contextualHref } from "@/app/installation-context";
import { Button, ContextHelp } from "@/components/cockpit/patterns";
import {
  ChangeReview,
  ChangeReviewActions,
  chatApprovalOutput,
  promptReviewChanges,
  useChangeReview,
  WorkflowReview,
} from "@/features/workflows";
import { formatDateTime, LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { approvalLine, type ChatApproval, type ChatApprovalOptions } from "../model/approval";
import { deviceApprovalRows, deviceLabelOf } from "../model/device-approval";
import { actionFacts } from "../model/policy";
import { ApprovalBinding } from "./policy";

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
  onDecision: (id: string, approved: boolean, options?: ChatApprovalOptions) => void;
  testId: string;
  conversationId?: string;
}) {
  const { t, tn, locale } = useI18n();
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewable = approval.savesInactiveWorkflow && Boolean(conversationId);
  const deadline = Date.parse(approval.expiresAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = !Number.isFinite(deadline) || deadline <= now;
  const device = approval.device;
  const devices = useQuery({
    queryKey: ["devices", "own"],
    queryFn: () => listDevices("own"),
    enabled: Boolean(device),
    retry: false,
  });
  const readable = (value: string) =>
    hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
  const title = t(
    device
      ? "chat.device.title"
      : approval.oauth
        ? "chat.reauth.title"
        : approval.singleRun
          ? "chat.singleRun.title"
          : approval.savesInactiveWorkflow
            ? "chat.decision.saveTitle"
            : "chat.decision.title",
  );
  const effect = approvalLine(approval, t, readable);
  const line = approval.transferBytes
    ? `${effect} ${t("chat.decision.transferSize", {
        size: formatBytes(approval.transferBytes, LOCALE_TAGS[locale]),
      })}`
    : effect;
  const binding = approval.binding;
  const rows = device
    ? deviceApprovalRows(device, deviceLabelOf(devices.data, device.device_id), t, testId)
    : binding
      ? actionFacts(binding.action, t, tn).map(
          (fact) =>
            [fact.label, fact.value, `${testId}-binding-${fact.id}`] as [string, string, string],
        )
      : [];
  const details = approval.description ?? (approval.singleRun ? approval.question : null);
  const pending = !approval.decidedByOthers && !expired && !busy;
  const changes = approval.changes ?? [];
  const changeReview = useChangeReview({ total: changes.length, digestRequired: false });
  const acceptChanges = (followUp?: string) =>
    onDecision(approval.id, true, {
      output: chatApprovalOutput(changeReview.selection, changes.length),
      ...(followUp ? { followUp } : {}),
    });
  return (
    <>
      <ToolApprovalCard
        testId={testId}
        icon={device ? Laptop : approval.oauth ? KeyRound : Wrench}
        title={
          <>
            {title}
            {details ? (
              <ContextHelp label={t("chat.decision.details")} testId={`${testId}-details`}>
                {readable(details)}
              </ContextHelp>
            ) : null}
          </>
        }
        rows={rows}
        quote={binding?.because ?? undefined}
        busy={busy}
        approveDisabled={expired || (approval.oauth === "complete" && !approval.authorizationUrl)}
        declineDisabled={expired}
        showPending={pending}
        onDecision={(allow) =>
          allow && reviewable ? setReviewOpen(true) : onDecision(approval.id, allow)
        }
        labels={{
          approve: t(
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
          ),
          decline: t("chat.approval.decline"),
          pending: t("chat.decision.pending"),
        }}
        actions={
          approval.decidedByOthers ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid={`${testId}-decided-by-others`}
            >
              {t("chat.taskRun.decidedByOthers")}
            </p>
          ) : changes.length > 0 ? (
            <>
              <ChangeReviewActions
                review={changeReview}
                busy={busy}
                blocked={expired}
                onAccept={() => acceptChanges()}
                onAcceptAndSave={() => acceptChanges(t("changeReview.savePrompt"))}
                testId={testId}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || expired}
                onClick={() => onDecision(approval.id, false)}
                data-testid={`${testId}-decline`}
              >
                {t("chat.approval.decline")}
              </Button>
            </>
          ) : undefined
        }
        footnote={
          <>
            <Clock aria-hidden="true" className="size-3.5 shrink-0" />
            <span aria-live="polite" data-testid={`${testId}-deadline`}>
              {expired
                ? t(device ? "chat.device.nothingChanged" : "chat.decision.expired")
                : `${t("chat.decision.validUntil")} ${formatDateTime(locale, approval.expiresAt)}`}
            </span>
            {binding && !expired ? (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid={`${testId}-scope-note`}>{t("chat.policy.scopeNote")}</span>
              </>
            ) : null}
          </>
        }
      >
        {binding || device ? null : (
          <p className="text-sm [overflow-wrap:anywhere]" data-testid={`${testId}-line`}>
            {line}
          </p>
        )}
        {binding ? <ApprovalBinding binding={binding} testId={testId} /> : null}
        {changes.length > 0 ? (
          <ChangeReview
            changes={promptReviewChanges(changes)}
            review={changeReview}
            disabled={busy || expired}
            testId={`${testId}-changes`}
          />
        ) : null}
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
          <ul
            className="flex list-disc flex-col gap-0.5 pl-5 text-sm"
            data-testid={`${testId}-subjects`}
          >
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
        {error && (
          <ErrorNotice
            kind="unknown"
            technical={false}
            title={t("chat.decision.failed")}
            body={t("chat.decision.failedBody")}
            testId={`${testId}-error`}
          />
        )}
      </ToolApprovalCard>
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
