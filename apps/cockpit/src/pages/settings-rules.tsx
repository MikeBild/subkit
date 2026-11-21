import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { Panel, Pill } from "@ui/components/proto/Pill";
import { EmptyState } from "@ui/components/proto/visual";
import { BookOpenCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  APPROVAL_RULES_KEY,
  type ApprovalRule,
  acceptApprovalRule,
  dismissApprovalRule,
  listApprovalRules,
  renewApprovalRule,
  revokeApprovalRule,
} from "@/api/approval-rules";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import {
  Button,
  ConfirmDialog,
  DataState,
  IconTile,
  SectionHeading,
} from "@/components/cockpit/patterns";
import { namedConnector, RuleFacts, ruleDates, splitRules } from "@/features/rules";
import { reportFailure } from "@/lib/action-failure";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import { ruleName } from "./chat-policy";

export function RuleRow({
  rule,
  busy,
  renewing = false,
  onRevoke,
  onRenew,
  onDecide,
}: {
  rule: ApprovalRule;
  busy: boolean;
  renewing?: boolean;
  onRevoke(rule: ApprovalRule): void;
  onRenew(rule: ApprovalRule): void;
  onDecide(rule: ApprovalRule, accept: boolean): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const name = ruleName(rule, t);
  const dates = ruleDates(rule);
  const active = rule.state === "active";
  const expired = active && rule.expired;
  return (
    <li
      className="grid gap-2.5 py-3"
      data-testid={`settings-rule-${rule.state}`}
      data-rule-state={rule.state}
      data-rule-expired={expired ? "true" : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IconTile>
            <BookOpenCheck />
          </IconTile>
          <SectionHeading className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
            {name}
          </SectionHeading>
          <span className="shrink-0" data-testid="settings-rule-state">
            <Pill tone={expired ? "warning" : active ? "success" : "neutral"}>
              {t(expired ? "rules.expired" : active ? "rules.active" : "rules.offered")}
            </Pill>
          </span>
        </div>
        {active ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={expired ? "default" : "outline"}
              size="sm"
              pending={renewing}
              disabled={busy}
              aria-label={t("rules.renewItem", { rule: name })}
              onClick={() => onRenew(rule)}
              data-testid="settings-rule-renew"
            >
              {t("rules.renew")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={t("rules.revokeItem", { rule: name })}
              onClick={() => onRevoke(rule)}
              data-testid="settings-rule-revoke"
            >
              {t("rules.revoke")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onDecide(rule, true)}
              data-testid="settings-rule-save"
            >
              {t("rules.save")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onDecide(rule, false)}
              data-testid="settings-rule-skip"
            >
              {t("rules.skip")}
            </Button>
          </div>
        )}
      </div>
      <RuleFacts rule={rule} testId="settings-rule" />
      <p className="text-xs text-muted-foreground" data-testid="settings-rule-meta">
        {[
          active
            ? dates.lastUsed
              ? t("rules.lastUsed", { date: dateTime(dates.lastUsed) })
              : t("rules.neverUsed")
            : t("rules.offeredAt", { date: dateTime(dates.created) }),
          active && rule.use_count > 0 ? tn("rules.useCount", rule.use_count) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  );
}

export function RulesArea() {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const rules = useQuery({
    queryKey: APPROVAL_RULES_KEY,
    queryFn: listApprovalRules,
    retry: false,
  });
  const [revoking, setRevoking] = useState<ApprovalRule | null>(null);
  const names = useConnectorNames();
  const refresh = () => client.invalidateQueries({ queryKey: APPROVAL_RULES_KEY });
  const revoke = useMutation({
    mutationFn: (rule: ApprovalRule) => revokeApprovalRule(rule.id),
    onSuccess: (_result, rule) => {
      toast.success(t("rules.revoked", { rule: ruleName(rule, t) }));
      setRevoking(null);
    },
    onError: (error) => {
      setRevoking(null);
      reportFailure(t("rules.revokeFailed"), error);
    },
    onSettled: refresh,
  });
  const renew = useMutation({
    mutationFn: (rule: ApprovalRule) => renewApprovalRule(rule.id),
    onSuccess: (renewed, rule) =>
      toast.success(
        renewed.expires_at
          ? t("rules.renewedUntil", { rule: ruleName(rule, t), date: dateTime(renewed.expires_at) })
          : t("rules.renewed", { rule: ruleName(rule, t) }),
      ),
    onError: (error) => reportFailure(t("rules.renewFailed"), error),
    onSettled: refresh,
  });
  const decide = useMutation({
    mutationFn: ({ rule, accept }: { rule: ApprovalRule; accept: boolean }) =>
      accept ? acceptApprovalRule(rule.id) : dismissApprovalRule(rule.id),
    onSuccess: (_result, { accept }) => toast.success(t(accept ? "rules.saved" : "rules.skipped")),
    onError: (error) => reportFailure(t("rules.decideFailed"), error),
    onSettled: refresh,
  });
  if (rules.isError)
    return (
      <ErrorNotice
        testId="settings-rules-load-failed"
        kind="rulesNotLoaded"
        title={t("rules.loadFailed")}
        body={t("setup.loadFailedBody")}
        primary={{ label: t("pattern.retry"), onClick: () => void rules.refetch() }}
        rows={errorRows(rules.error, t)}
      />
    );
  if (!rules.data) return <DataState state="loading" testId="settings-rules-loading" />;
  const { active, offered } = splitRules(
    rules.data.map((rule) => namedConnector(rule, (id) => names.get(id))),
  );
  const busy = revoke.isPending || decide.isPending || renew.isPending;
  return (
    <div className="flex flex-col gap-4" data-testid="settings-area-rules">
      {active.length + offered.length === 0 ? (
        <div data-testid="settings-rules-empty">
          <EmptyState icon={BookOpenCheck} title={t("rules.empty")} text={t("rules.emptyText")} />
        </div>
      ) : (
        <Panel className="py-1">
          <ul className="divide-y" data-testid="settings-rules-list">
            {[...offered, ...active].map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                busy={busy}
                renewing={renew.isPending && renew.variables?.id === rule.id}
                onRevoke={setRevoking}
                onRenew={(target) => renew.mutate(target)}
                onDecide={(target, accept) => decide.mutate({ rule: target, accept })}
              />
            ))}
          </ul>
        </Panel>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        object={t("rules.revokeObject", { rule: revoking ? ruleName(revoking, t) : "" })}
        verb={t("rules.revokeVerb")}
        consequence={t("rules.revokeBody")}
        confirmLabel={t("rules.revoke")}
        destructive
        pending={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
        testId="settings-rule-revoke-confirm"
      />
    </div>
  );
}
