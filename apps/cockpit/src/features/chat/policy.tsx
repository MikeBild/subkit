import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Button, ErrorNotice, FactList, TextBlock } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  type ApprovalBinding as ApprovalBindingModel,
  actionFacts,
  askReasonKey,
  fullContent,
  LIVE_POLICY_KEY,
  namedAccount,
  type RuleOffer,
  ranLine,
  ranWithoutAsking,
  refusedApprovalReply,
  scopeSentence,
  type ToolCallPolicy,
  typedDecision,
} from "@/pages/chat-policy";
import type { ChatTurn } from "@/pages/chat-turn";
import { contentClassLine, todayLine, validityLine } from "@/pages/settings-rules-model";

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
  const { t, tn } = useI18n();
  const reason = askReasonKey(binding.askReason);
  const content = fullContent(binding.action);
  return (
    <div className="grid gap-3" data-testid={`${testId}-binding`}>
      <p className="text-sm font-medium">{t("chat.policy.wants")}</p>
      <FactList
        items={actionFacts(binding.action, t).map((fact) => ({
          label: fact.label,
          value: <span className="[overflow-wrap:anywhere]">{fact.value}</span>,
          testId: `${testId}-binding-${fact.id}`,
        }))}
      />
      {content ? (
        <TextBlock
          label={t("chat.policy.fullContent")}
          text={content.text}
          truncated={content.capped}
          note={
            content.capped
              ? t("chat.policy.contentCapped", { count: content.text.length })
              : [
                  tn("chat.policy.contentLength", content.text.length),
                  content.long ? t("chat.policy.contentScroll") : null,
                ]
                  .filter(Boolean)
                  .join(" ")
          }
          testId={`${testId}-content`}
        />
      ) : null}
      {binding.because ? (
        <p className="text-sm" data-testid={`${testId}-because`}>
          {t("chat.policy.because", { quote: binding.because })}
        </p>
      ) : reason ? (
        <div className="grid gap-0.5">
          <p className="text-sm" data-testid={`${testId}-ask-reason`}>
            {t(reason)}
          </p>
          {binding.askDetail ? (
            <p
              className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
              data-testid={`${testId}-ask-detail`}
            >
              {t("common.engineWording", { text: binding.askDetail })}
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-scope-note`}>
        {t("chat.policy.scopeNote")}
      </p>
    </div>
  );
}

function RuleOfferCard({ offer, testId }: { offer: RuleOffer; testId: string }) {
  const { t, dateTime } = useI18n();
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
  if (decide.isSuccess)
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-decided`}>
        {t(decide.variables ? "rules.saved" : "rules.skipped")}
      </p>
    );
  if (!offered) return null;
  return (
    <div
      className="grid gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm"
      data-testid={testId}
    >
      <p className="font-medium">{t("rules.prompt")}</p>
      <p className="text-muted-foreground" data-testid={`${testId}-scope`}>
        <span className="font-medium text-foreground">{t("rules.scope")}:</span>{" "}
        <span className="[overflow-wrap:anywhere]">{scopeSentence(offer, t)}</span>
      </p>
      <ul className="grid gap-0.5 text-muted-foreground" data-testid={`${testId}-limits`}>
        <li data-testid={`${testId}-content`}>{contentClassLine(offered.content_class, t)}</li>
        <li data-testid={`${testId}-validity`}>{validityLine(offered, t, dateTime)}</li>
        <li data-testid={`${testId}-daily`}>{todayLine(offered, t)}</li>
      </ul>
      {decide.isError ? (
        <ErrorNotice
          title={t("rules.decideFailed")}
          error={decide.error}
          remedy={{
            label: t("pattern.retry"),
            variant: "primary",
            size: "sm",
            onClick: () => decide.mutate(decide.variables ?? false),
            testId: `${testId}-error-retry`,
          }}
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
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="[overflow-wrap:anywhere]" data-testid={`${testId}-line`}>
              {ranLine(ran, t)}
            </span>
            {ran.quote ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                aria-expanded={quoteShown}
                onClick={() => setQuoteShown((shown) => !shown)}
                data-testid={`${testId}-quote-toggle`}
              >
                {t("chat.policy.showQuote")}
              </Button>
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
            <p className="text-foreground" data-testid={`${testId}-quote`}>
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
        tone="warn"
        testId="chat-reply-refused"
        title={t("chat.policy.meant", {
          choice: t(meant === "approve" ? "chat.approval.approve" : "chat.approval.decline"),
        })}
        body={t("chat.policy.meantBody")}
        remedy={
          <Button
            size="sm"
            disabled={busy}
            onClick={() => decide(meant === "approve")}
            data-testid={`chat-reply-meant-${meant}`}
            data-meant={meant}
          >
            {t(meant === "approve" ? "chat.approval.approve" : "chat.approval.decline")}
          </Button>
        }
        secondary={
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => send.reset()}
            data-testid="chat-reply-meant-dismiss"
          >
            {t("chat.policy.meantNo")}
          </Button>
        }
      />
    );
  return (
    <ErrorNotice
      tone="warn"
      testId="chat-reply-refused"
      title={t("chat.policy.changeRefused")}
      body={t("chat.policy.changeRefusedBody")}
      remedy={
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
