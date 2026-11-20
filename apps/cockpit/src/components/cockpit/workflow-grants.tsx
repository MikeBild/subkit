import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName } from "@/app/actor-directory-model";
import {
  authorityValidity,
  MakeUntilRevoked,
  UntilRevokedDone,
  UntilRevokedHint,
} from "@/components/cockpit/authority-until-revoked";
import type { WorkflowAutomation } from "@/components/cockpit/automation-panel";
import { useConnectorNames, useConnectorServices } from "@/components/cockpit/connector-names";
import { GrantEffectReview } from "@/components/cockpit/grant-effect-review";
import { OPENS_APPROVAL } from "@/components/cockpit/opens-approval";
import {
  ActionButton,
  ActionMenu,
  ConfirmDialog,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  Section,
  StatusBadge,
  TabBody,
  TechnicalDetails,
  Timeline,
  type TimelineItem,
} from "@/components/cockpit/patterns";
import { type AuthorityReviewPreview, authorityReviewModel } from "@/lib/authority-review-model";
import { automationQueryKeys } from "@/lib/automation-queries";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type AuthorityPages, withAuthorityRevoked } from "@/lib/optimistic-authorities";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  AUTHORITY_EFFECT_KEYS,
  AUTHORITY_STATE_KEYS,
  authorityHeadline,
  authorityVersionLabel,
  observedAuthorityState,
  untilRevokedOffer,
  type WorkflowAuthority,
} from "@/lib/workflow-authorities";

function badgeState(state: WorkflowAuthority["state"]): string {
  return state === "approved" ? "approved" : state === "not_yet_valid" ? "pending" : "inactive";
}

function grantPreview(authority: WorkflowAuthority): AuthorityReviewPreview {
  return { manifest: authority.effect_manifest, approval_carries_over: false, schedules: [] };
}

function useAuthorityModel(
  preview: AuthorityReviewPreview | null,
  automation: WorkflowAutomation,
  activation: boolean,
) {
  const connectorNames = useConnectorNames();
  const connectorServices = useConnectorServices();
  if (!preview) return null;
  const triggers = automation.state?.triggers ?? [];
  return authorityReviewModel({
    preview,
    connectorNames,
    connectorServices,
    automation: {
      schedule: triggers.some((trigger) => trigger.kind === "schedule"),
      webhook: triggers.some((trigger) => trigger.kind === "hook"),
    },
    activation,
    carryOver: Boolean(preview.approval_carries_over),
  });
}

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: "dev" | "prod") =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

function useEffectFacts(authority: WorkflowAuthority): Fact[] {
  const { t } = useI18n();
  const connectorNames = useConnectorNames();
  return authority.effect_manifest.effects.map((effect) => ({
    label: effect.step_id,
    value: [
      t(AUTHORITY_EFFECT_KEYS[effect.effect]),
      `${effect.driver} / ${effect.operation}`,
      effect.connector_id
        ? (connectorNames.get(effect.connector_id) ?? t("authority.configuredConnector"))
        : t("authority.directRequest"),
      effect.target ?? t("authority.unboundTarget"),
    ].join(" · "),
  }));
}

function ApprovalSheet({
  authority,
  automation,
  onClose,
}: {
  authority: WorkflowAuthority;
  automation: WorkflowAutomation;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const directory = useActorDirectory(true);
  const environmentWord = useEnvironmentWord();
  const version = authorityVersionLabel(authority.workflow_version_id, automation.versions);
  const state = observedAuthorityState(authority, automation.now);
  const effects = useEffectFacts(authority);
  const model = useAuthorityModel(grantPreview(authority), automation, false);
  const facts: Fact[] = [
    {
      label: t("workflowApprovals.sheet.by"),
      value: actorDirectoryName(directory, "user", authority.created_by) ?? t("audit.actor.user"),
      testId: "authority-granted-by",
    },
    {
      label: t("workflowApprovals.sheet.at"),
      value: formatDateTime(locale, authority.created_at),
    },
    {
      label: t("authority.window"),
      value: `${formatDateTime(locale, authority.valid_from)} — ${
        authority.valid_until !== null
          ? formatDateTime(locale, authority.valid_until)
          : authority.open_ended
            ? t("authority.headline.untilRevoked")
            : t("workflowApprovals.validity.noEnd")
      }`,
    },
    {
      label: t("authority.runs"),
      value:
        authority.max_runs === null || authority.remaining_runs === null
          ? t("authority.runsUnlimited", { count: authority.reserved_runs })
          : t("authority.remaining", {
              remaining: authority.remaining_runs,
              max: authority.max_runs,
            }),
    },
    {
      label: t("authority.version"),
      value: <span title={version.full ?? undefined}>{version.text}</span>,
      testId: "authority-version",
    },
  ];
  return (
    <RecordSheet
      dock
      open
      onOpenChange={(next) => !next && onClose()}
      title={t("workflowApprovals.sheet.title", {
        environment: environmentWord(authority.execution_environment),
      })}
      subtitle={
        <span data-testid="authority-headline">{authorityHeadline(authority, t, locale)}</span>
      }
      badge={<StatusBadge state={badgeState(state)} label={t(AUTHORITY_STATE_KEYS[state])} />}
      menu={
        automation.canWrite && !authority.revoked_at ? (
          <RevokeApproval
            authority={authority}
            versionText={version.text}
            testId="authority-sheet"
            onRevoked={onClose}
          />
        ) : undefined
      }
      testId="authority-sheet"
      closeTestId="authority-sheet-close"
    >
      {authority.active_version ? null : (
        <p className="text-sm text-muted-foreground" data-testid="authority-inactive-version">
          {t("authority.inactiveVersion")}
        </p>
      )}
      <GrantEffectReview model={model} growth={undefined} problems={[]} loading={false} />
      <FactList items={facts} testId="authority-facts" />
      <TechnicalDetails testId="authority-technical">
        <FactList
          testId="authority-effects"
          items={[
            {
              label: t("authority.digest"),
              value: (
                <span className="break-all font-mono text-xs">
                  {authority.effect_manifest_digest}
                </span>
              ),
            },
            ...effects,
          ]}
        />
      </TechnicalDetails>
    </RecordSheet>
  );
}

function RevokeApproval({
  authority,
  versionText,
  testId,
  onRevoked,
}: {
  authority: WorkflowAuthority;
  versionText: string;
  testId: string;
  onRevoked?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const revoke = useOptimisticAction({
    queryKey: ["workflow-authorities", authority.workflow_id],
    mutationFn: () =>
      apiCall("post", "/v1/workflows/{id}/execution-authorities/{authority_id}/revoke", {
        path: { id: authority.workflow_id, authority_id: authority.id },
      }),
    apply: (current: AuthorityPages | undefined) =>
      withAuthorityRevoked(current, authority.id, new Date().toISOString()),
    invalidate: [
      ...automationQueryKeys(authority.workflow_id).filter(
        (key) => key[0] !== "workflow-authorities" || key.length > 2,
      ),
      ["attention"],
    ],
    errorMessage: () => t("authority.revokeFailed"),
    onSuccess: () => {
      setOpen(false);
      onRevoked?.();
    },
  });
  return (
    <>
      <ActionMenu
        size="sm"
        items={[
          {
            label: t("workflowApprovals.revoke"),
            onSelect: () => setOpen(true),
            destructive: true,
            testId: `${testId}-revoke`,
          },
        ]}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !revoke.isPending && setOpen(next)}
        object={t("workflowApprovals.object", { version: versionText })}
        verb={t("workflowApprovals.revoke")}
        consequence={t("workflowApprovals.revokeConsequence")}
        destructive
        pending={revoke.isPending}
        onConfirm={async () => {
          await revoke.mutateAsync(undefined).catch(() => undefined);
        }}
        testId="authority-revoke"
      />
    </>
  );
}

function PendingVersion({
  automation,
  offersApproval,
}: {
  automation: WorkflowAutomation;
  offersApproval: boolean;
}) {
  const { t } = useI18n();
  const environmentWord = useEnvironmentWord();
  const state = automation.state;
  const target = state?.target?.kind === "prepared" ? state.target : null;
  const environment = state?.environment ?? "prod";
  const preview = useQuery({
    queryKey: [
      "workflow-authority-preview",
      automation.workflowId,
      target?.version_id,
      environment,
    ],
    enabled: Boolean(target),
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/versions/{version_id}/authority-preview", {
        path: { id: automation.workflowId, version_id: target?.version_id ?? "" },
        query: { environment },
      }),
  });
  const model = useAuthorityModel(preview.data ?? null, automation, true);
  if (!target) return null;
  const label = (value: number | null) => (value === null ? "—" : `v${value}`);
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid="workflow-pending-version"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {t("workflowApprovals.pending.title", { version: label(target.version) })}
        </span>
        <StatusBadge state="pending" label={t("workflowApprovals.pending.badge")} />
        {offersApproval || !automation.canWrite ? null : (
          <span className="ml-auto">
            <ActionButton
              size="sm"
              onClick={automation.openGrant}
              data={OPENS_APPROVAL}
              testId="workflow-pending-approve"
            >
              {t("workflowStrip.action.grant")}
            </ActionButton>
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {target.active_version === null
          ? t("workflowApprovals.pending.first", { environment: environmentWord(environment) })
          : t("workflowApprovals.pending.keeps", {
              version: label(target.active_version),
              environment: environmentWord(environment),
            })}
      </p>
      {preview.error ? (
        <DataState
          state="error"
          line={t("workflowApprovals.pending.failed")}
          onRetry={() => void preview.refetch()}
          testId="workflow-pending-failed"
        />
      ) : (
        <GrantEffectReview
          model={model}
          growth={preview.data?.boundary_growth}
          problems={[]}
          loading={preview.isPending}
          toolPinsCompared={preview.data?.tool_pins_compared === true}
        />
      )}
    </section>
  );
}

function ActiveGrant({
  authority,
  automation,
  onOpen,
  madeUntilRevoked,
  onUntilRevoked,
}: {
  authority: WorkflowAuthority;
  automation: WorkflowAutomation;
  onOpen(): void;
  madeUntilRevoked: boolean;
  onUntilRevoked(): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const directory = useActorDirectory(true);
  const environmentWord = useEnvironmentWord();
  const model = useAuthorityModel(grantPreview(authority), automation, false);
  const state = observedAuthorityState(authority, automation.now);
  const version = authorityVersionLabel(authority.workflow_version_id, automation.versions);
  const title = t("workflowApprovals.active.title", {
    version: version.text,
    environment: environmentWord(authority.execution_environment),
  });
  const offer = untilRevokedOffer(authority, automation.now, automation.canWrite);
  return (
    <section className="flex flex-col gap-3" data-testid="authority-current">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <StatusBadge state={badgeState(state)} label={t(AUTHORITY_STATE_KEYS[state])} />
        <span className="text-xs text-muted-foreground" data-testid="authority-current-validity">
          {[
            authorityValidity(authority, { t, tn, dateTime }),
            t("workflowApprovals.active.granted", {
              when: dateTime(authority.created_at),
              who:
                actorDirectoryName(directory, "user", authority.created_by) ??
                t("audit.actor.user"),
            }),
          ].join(" · ")}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {offer ? (
            <MakeUntilRevoked
              authority={authority}
              subject={title}
              tiles={model?.tiles ?? null}
              onDone={onUntilRevoked}
            />
          ) : null}
          <ActionButton size="sm" onClick={onOpen} testId="authority-current-open">
            {t("workflowApprovals.details")}
          </ActionButton>
          {automation.canWrite && !authority.revoked_at ? (
            <RevokeApproval
              authority={authority}
              versionText={version.text}
              testId="authority-current"
            />
          ) : null}
        </span>
      </div>
      {offer ? (
        <UntilRevokedHint days={offer.days} remainingRuns={authority.remaining_runs} />
      ) : null}
      {madeUntilRevoked && authority.open_ended ? <UntilRevokedDone /> : null}
      <GrantEffectReview model={model} growth={undefined} problems={[]} loading={false} />
    </section>
  );
}

export function WorkflowApprovals({
  automation,
  offersApproval,
}: {
  automation: WorkflowAutomation;
  offersApproval: boolean;
}) {
  const { t, locale, dateTime } = useI18n();
  const directory = useActorDirectory(true);
  const environmentWord = useEnvironmentWord();
  const [openId, setOpenId] = useSearchParamState("grant", "");
  const [madeUntilRevoked, setMadeUntilRevoked] = useState(false);
  const setOpen = (authority: WorkflowAuthority | null) => setOpenId(authority?.id ?? "");
  const { state } = automation;
  if (!state)
    return (
      <TabBody>
        <DataState state="loading" testId="workflow-approvals-loading" />
      </TabBody>
    );
  const prepared = state.target?.kind === "prepared";
  const grant = state.grant;
  const earlier = [...(prepared && grant ? [grant] : []), ...state.alsoValid, ...state.history];
  const open = openId
    ? ([grant, ...earlier].find((authority) => authority?.id === openId) ?? null)
    : null;
  const timeline: TimelineItem[] = earlier.map((authority, index) => {
    const observed = observedAuthorityState(authority, automation.now);
    const version = authorityVersionLabel(authority.workflow_version_id, automation.versions);
    return {
      id: authority.id,
      tone: observed === "approved" ? "ok" : observed === "not_yet_valid" ? "info" : "neutral",
      title: t("workflowApprovals.active.title", {
        version: version.text,
        environment: environmentWord(authority.execution_environment),
      }),
      meta: [
        authorityHeadline(authority, t, locale),
        t("workflowApprovals.active.granted", {
          when: dateTime(authority.created_at),
          who: actorDirectoryName(directory, "user", authority.created_by) ?? t("audit.actor.user"),
        }),
      ].join(" · "),
      aside: <StatusBadge state={badgeState(observed)} label={t(AUTHORITY_STATE_KEYS[observed])} />,
      onOpen: () => setOpen(authority),
      label: authorityHeadline(authority, t, locale),
      testId: `authority-history-${index}`,
    };
  });
  const summary = grant
    ? t("workflowApprovals.summary.active", { boundary: authorityHeadline(grant, t, locale) })
    : prepared
      ? t("workflowApprovals.summary.pending")
      : t("workflowApprovals.summary.none");
  const showGrantTrigger =
    !prepared &&
    !grant &&
    !offersApproval &&
    automation.canWrite &&
    state.primaryAction?.kind === "grant";
  return (
    <TabBody
      testId="workflow-approvals"
      summary={summary}
      more={
        earlier.length > 0 || automation.history.hasMore ? (
          <Section label={t("workflowApprovals.earlier")} testId="workflow-former-grants">
            <Timeline groups={[{ items: timeline }]} testId="workflow-approvals-timeline" />
            {automation.history.hasMore ? (
              <span>
                <ActionButton
                  size="sm"
                  variant="ghost"
                  disabled={automation.history.loading}
                  onClick={automation.history.more}
                  testId="authority-more"
                >
                  {t("authority.more")}
                </ActionButton>
              </span>
            ) : null}
          </Section>
        ) : null
      }
    >
      {prepared ? (
        <PendingVersion automation={automation} offersApproval={offersApproval} />
      ) : grant ? (
        <ActiveGrant
          authority={grant}
          automation={automation}
          onOpen={() => setOpen(grant)}
          madeUntilRevoked={madeUntilRevoked}
          onUntilRevoked={() => setMadeUntilRevoked(true)}
        />
      ) : (
        <DataState
          state="empty"
          line={t("workflowApprovals.none")}
          action={
            showGrantTrigger ? (
              <ActionButton
                size="sm"
                onClick={automation.openGrant}
                data={OPENS_APPROVAL}
                testId="workflow-approvals-grant"
              >
                {t("workflowStrip.action.grant")}
              </ActionButton>
            ) : undefined
          }
          testId="workflow-approvals-empty"
        />
      )}
      {open ? (
        <ApprovalSheet authority={open} automation={automation} onClose={() => setOpen(null)} />
      ) : null}
    </TabBody>
  );
}
