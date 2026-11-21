import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorNotice, TechDetail } from "@ui/components/proto/ErrorNotice";
import { BookOpenCheck, CircleCheck, MessageCircleQuestion, Quote } from "lucide-react";
import { useState } from "react";
import {
  APPROVAL_RULES_KEY,
  acceptApprovalRule,
  dismissApprovalRule,
  listApprovalRules,
} from "@/api/approval-rules";
import { ApiError, getConversation } from "@/api/client";
import { absolute, settingsHref } from "@/app/links";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  Button,
  ContextHelp,
  IconTile,
  renderAction,
  TextBlock,
  useErrorNotice,
} from "@/components/cockpit/patterns";
import { namedConnector, RuleFacts } from "@/features/rules";
import { useI18n } from "@/lib/i18n-context";
import {
  type ApprovalBinding as ApprovalBindingModel,
  actionLine,
  askReasonKey,
  fullContent,
  LIVE_POLICY_KEY,
  namedAccount,
  type RuleOffer,
  ranWithoutAsking,
  rawRequest,
  refusedApprovalReply,
  ruleName,
  type ToolCallPolicy,
  typedDecision,
} from "@/pages/chat-policy";
import type { ChatTurn } from "@/pages/chat-turn";

function useToolCall(conversationId: string | undefined, toolCallId: string) {
  const detail = useQuery({
    queryKey: ["conversation", conversationId ?? null],
    queryFn: () => getConversation(conversationId ?? ""),
    enabled: false,
  });
  const live = useQuery<ToolCallPolicy | null>({
    queryKey: [LIVE_POLICY_KEY, toolCallId],
    queryFn: () => null,
    enabled: false,
  });
  const stored = detail.data?.tool_calls.find((call) => call.id === toolCallId) ?? null;
  return { policy: stored?.policy ?? live.data ?? null };
}

export function ApprovalBinding({
  binding,
  testId,
}: {
  binding: ApprovalBindingModel;
  testId: string;
}) {
  const { t } = useI18n();
  const reason = binding.because ? null : askReasonKey(binding.askReason);
  const content = fullContent(binding.action);
  const request = rawRequest(binding.action.target);
  if (!content && !reason && !request) return null;
  return (
    <div className="grid gap-3" data-testid={`${testId}-binding`}>
      {content ? (
        <TextBlock
          label={t("chat.policy.fullContent")}
          text={content.text}
          truncated={content.capped}
          note={
            content.capped
              ? t("chat.policy.contentCapped", { count: content.text.length })
              : undefined
          }
          testId={`${testId}-content`}
        />
      ) : null}
      {reason ? (
        <p className="flex items-start gap-2 text-sm">
          <MessageCircleQuestion
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span data-testid={`${testId}-ask-reason`}>{t(reason)}</span>
          {binding.askDetail ? (
            <ContextHelp label={t("chat.decision.details")} testId={`${testId}-ask-detail`}>
              {t("common.engineWording", { text: binding.askDetail })}
            </ContextHelp>
          ) : null}
        </p>
      ) : null}
      {request ? (
        <TechDetail
          kind="approval_request"
          rows={[[t("chat.policy.field.request"), request]]}
          report={false}
          testId={`${testId}-request`}
        />
      ) : null}
    </div>
  );
}

function RuleOfferCard({ offer, testId }: { offer: RuleOffer; testId: string }) {
  const { t } = useI18n();
  const names = useConnectorNames();
  const nameFor = (id: string) => names.get(id);
  const client = useQueryClient();
  const rules = useQuery({
    queryKey: APPROVAL_RULES_KEY,
    queryFn: listApprovalRules,
    staleTime: 30_000,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (accept: boolean) =>
      accept ? acceptApprovalRule(offer.rule_id) : dismissApprovalRule(offer.rule_id),
    onSettled: () => client.invalidateQueries({ queryKey: APPROVAL_RULES_KEY }),
  });
  const offered = rules.data?.find((rule) => rule.id === offer.rule_id && rule.state === "offered");
  const decideFailure = useErrorNotice({ error: decide.error });
  if (decide.isSuccess)
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-decided`}>
        {t(decide.variables ? "rules.saved" : "rules.skipped")}
      </p>
    );
  if (!offered) return null;
  return (
    <div className="grid gap-2.5 rounded-xl border p-4 text-sm" data-testid={testId}>
      <div className="flex items-center gap-3">
        <IconTile size="sm">
          <BookOpenCheck />
        </IconTile>
        <p className="font-semibold">{t("rules.prompt")}</p>
      </div>
      <p data-testid={`${testId}-scope`}>
        <span className="text-muted-foreground">{t("rules.scope")}: </span>
        <span className="[overflow-wrap:anywhere]">{ruleName(offer, t)}</span>
      </p>
      <RuleFacts rule={namedConnector(offered, nameFor)} testId={testId} />
      {decide.isError ? (
        <ErrorNotice
          {...decideFailure}
          title={t("rules.decideFailed")}
          actions={renderAction({
            label: t("pattern.retry"),
            variant: "primary",
            size: "sm",
            onClick: () => decide.mutate(decide.variables ?? false),
            testId: `${testId}-error-retry`,
          })}
          testId={`${testId}-error`}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          pending={decide.isPending && decide.variables === true}
          disabled={decide.isPending}
          onClick={() => decide.mutate(true)}
          data-testid={`${testId}-save`}
        >
          {t("rules.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          pending={decide.isPending && decide.variables === false}
          disabled={decide.isPending}
          onClick={() => decide.mutate(false)}
          data-testid={`${testId}-skip`}
        >
          {t("rules.skip")}
        </Button>
      </div>
    </div>
  );
}

export function ToolPolicyNote({
  conversationId,
  toolCallId,
  testId,
}: {
  conversationId: string | undefined;
  toolCallId: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [quoteShown, setQuoteShown] = useState(false);
  const call = useToolCall(conversationId, toolCallId);
  const policy = call.policy;
  const names = useConnectorNames();
  const nameFor = (id: string) => names.get(id);
  const asked = ranWithoutAsking(policy);
  const ran = asked ? { ...asked, action: namedAccount(asked.action, nameFor) } : null;
  const offer = policy?.rule_offer ? namedAccount(policy.rule_offer, nameFor) : null;
  if (!ran && !offer) return null;
  return (
    <>
      {ran ? (
        <div
          className="grid gap-1 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid={testId}
        >
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success-ink" />
            <span className="[overflow-wrap:anywhere]" data-testid={`${testId}-line`}>
              <span className="text-foreground">{actionLine(ran.action, t)}</span>
              {" · "}
              {t(
                ran.rule === "standing_rule"
                  ? "chat.policy.becauseRule"
                  : "chat.policy.becauseAsked",
              )}
            </span>
            {ran.quote ? (
              <IconButton
                variant="ghost"
                size="icon-xs"
                label={t("chat.policy.showQuote")}
                aria-expanded={quoteShown}
                onClick={() => setQuoteShown((shown) => !shown)}
                data-testid={`${testId}-quote-toggle`}
              >
                <Quote />
              </IconButton>
            ) : ran.rule === "standing_rule" ? (
              <Button asChild variant="link" size="sm" className="h-auto px-0 text-xs">
                <a
                  href={absolute(settingsHref(null, { area: "rules" }))}
                  data-testid={`${testId}-rules`}
                >
                  {t("chat.policy.openRules")}
                </a>
              </Button>
            ) : null}
          </p>
          {ran.quote && quoteShown ? (
            <p
              className="flex items-start gap-1.5 pl-5 text-foreground"
              data-testid={`${testId}-quote`}
            >
              {t("chat.policy.because", { quote: ran.quote })}
            </p>
          ) : null}
        </div>
      ) : null}
      {offer ? <RuleOfferCard offer={offer} testId={`${testId}-offer`} /> : null}
    </>
  );
}

export function RefusedReply({ turn, busy }: { turn: ChatTurn; busy: boolean }) {
  const { t } = useI18n();
  const { sendError, send, submitApproval } = turn;
  const elicitationId = sendError instanceof ApiError ? refusedApprovalReply(sendError) : null;
  if (!elicitationId) return null;
  const meant = typedDecision(send.variables?.message);
  const decide = (approved: boolean) => {
    send.reset();
    submitApproval(elicitationId, approved);
  };
  if (meant)
    return (
      <ErrorNotice
        kind="unknown"
        technical={false}
        tone="warning"
        testId="chat-reply-refused"
        title={t("chat.policy.meant", {
          choice: t(meant === "approve" ? "chat.approval.approve" : "chat.approval.decline"),
        })}
        body={t("chat.policy.meantBody")}
        actions={
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => decide(meant === "approve")}
              data-testid={`chat-reply-meant-${meant}`}
              data-meant={meant}
            >
              {t(meant === "approve" ? "chat.approval.approve" : "chat.approval.decline")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => send.reset()}
              data-testid="chat-reply-meant-dismiss"
            >
              {t("chat.policy.meantNo")}
            </Button>
          </>
        }
      />
    );
  return (
    <ErrorNotice
      kind="unknown"
      technical={false}
      tone="warning"
      testId="chat-reply-refused"
      title={t("chat.policy.changeRefused")}
      body={t("chat.policy.changeRefusedBody")}
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => decide(false)}
          data-testid="chat-reply-refused-decline"
        >
          {t("chat.policy.declineAndRephrase")}
        </Button>
      }
    />
  );
}
