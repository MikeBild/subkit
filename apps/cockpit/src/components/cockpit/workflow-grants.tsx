import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { WorkflowAutomation } from "@/components/cockpit/automation-panel";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import {
  ActionMenu,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  Section,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { tableColumns } from "@/components/cockpit/table-columns";
import { invalidateWorkflowAutomation } from "@/lib/automation-queries";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  AUTHORITY_EFFECT_KEYS,
  AUTHORITY_STATE_KEYS,
  authorityHeadline,
  authorityVersionLabel,
  observedAuthorityState,
  type WorkflowAuthority,
} from "@/lib/workflow-authorities";

/** The approval's engine state as the badge reads it: approved, or not any more. */
function badgeState(state: WorkflowAuthority["state"]): string {
  return state === "approved" ? "approved" : state === "not_yet_valid" ? "pending" : "inactive";
}

/** What an approval permits — the part a reader decides by — as facts. */
function useEffectFacts(authority: WorkflowAuthority): Fact[] {
  const { t } = useI18n();
  const connectorNames = useConnectorNames();
  return authority.effect_manifest.effects.map((effect) => ({
    label: effect.step_id,
    value: [
      t(AUTHORITY_EFFECT_KEYS[effect.effect]),
      `${effect.driver} / ${effect.operation}`,
      // The connector by its name, as the approval dialog names it — never a
      // fragment of its id.
      effect.connector_id
        ? (connectorNames.get(effect.connector_id) ?? t("authority.configuredConnector"))
        : t("authority.directRequest"),
      effect.target ?? t("authority.unboundTarget"),
    ].join(" · "),
  }));
}

/** One approval (O6): what it permits, and its exact boundary for whoever has to quote it. */
function ApprovalSheet({
  authority,
  versions,
  now,
  onClose,
}: {
  authority: WorkflowAuthority;
  versions: ReadonlyMap<string, number>;
  now: number;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const version = authorityVersionLabel(authority.workflow_version_id, versions);
  const state = observedAuthorityState(authority, now);
  const effects = useEffectFacts(authority);
  const facts: Fact[] = [
    {
      label: t("authority.version"),
      value: <span title={version.full ?? undefined}>{version.text}</span>,
      testId: "authority-version",
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
      label: t("authority.window"),
      value: `${formatDateTime(locale, authority.valid_from)} — ${
        authority.valid_until === null
          ? t("authority.headline.untilRevoked")
          : formatDateTime(locale, authority.valid_until)
      }`,
    },
    {
      label: t("authority.digest"),
      // A hash is evidence: its head identifies it, the whole stays on the title.
      value: (
        <span className="font-mono text-xs" title={authority.effect_manifest_digest}>
          {`${authority.effect_manifest_digest.slice(0, 12)}…`}
        </span>
      ),
    },
  ];
  return (
    <RecordSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={<span title={authority.id}>{authorityHeadline(authority, t, locale)}</span>}
      titleTestId="authority-headline"
      badge={<StatusBadge state={badgeState(state)} label={t(AUTHORITY_STATE_KEYS[state])} />}
      testId="authority-sheet"
      closeTestId="authority-sheet-close"
    >
      {/* An approval can be valid and still cover nothing that runs. */}
      {authority.active_version ? null : (
        <p className="text-sm text-muted-foreground" data-testid="authority-inactive-version">
          {t("authority.inactiveVersion")}
        </p>
      )}
      <FactList items={facts} testId="authority-facts" />
      <Section label={t("workflowApprovals.permits")}>
        {effects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("authority.noEffects")}</p>
        ) : (
          <FactList items={effects} testId="authority-effects" />
        )}
      </Section>
    </RecordSheet>
  );
}

/** "Widerrufen" on one approval (O5), with the one line of what it stops. */
function RevokeApproval({
  authority,
  versionText,
  testId,
}: {
  authority: WorkflowAuthority;
  versionText: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      apiRequest<WorkflowAuthority>(
        `/v1/workflows/${encodeURIComponent(authority.workflow_id)}/execution-authorities/${encodeURIComponent(authority.id)}/revoke`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      // A revoked approval changes the verdict, the diagnosis and what the
      // call promises — and the attention list, once a start is refused.
      await invalidateWorkflowAutomation(client, authority.workflow_id);
      await client.invalidateQueries({ queryKey: ["attention"] });
      setOpen(false);
    },
    onError: () => toast.error(t("authority.revokeFailed")),
  });
  return (
    <>
      <ActionMenu
        items={[
          {
            label: t("workflowApprovals.revoke"),
            onSelect: () => setOpen(true),
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
          await revoke.mutateAsync().catch(() => undefined);
        }}
        testId="authority-revoke"
      />
    </>
  );
}

function ApprovalTable({
  items,
  automation,
  collectionId,
  rowTestId,
  emptyLine,
}: {
  items: readonly WorkflowAuthority[];
  automation: WorkflowAutomation;
  collectionId: string;
  /** The positional test id of row `index` — an approval's id never becomes a selector. */
  rowTestId: (index: number) => string;
  emptyLine: string;
}) {
  const { t, locale, dateTime } = useI18n();
  const [open, setOpen] = useState<WorkflowAuthority | null>(null);
  const { versions, now } = automation;
  const columns = useMemo<CockpitColumn<WorkflowAuthority>[]>(() => {
    const column = tableColumns<WorkflowAuthority>({ t, dateTime });
    return [
      column.custom(
        "version",
        (authority) => authority.workflow_version_id,
        t("authority.version"),
        (authority) => authorityVersionLabel(authority.workflow_version_id, versions).text,
        { width: "w-[14%]" },
      ),
      column.custom(
        "boundary",
        (authority) => authority.valid_until,
        t("workflowApprovals.column.boundary"),
        (authority) => authorityHeadline(authority, t, locale),
        { width: "w-[52%]" },
      ),
      column.custom(
        "state",
        (authority) => authority.state,
        t("resource.field.status"),
        (authority) => {
          const state = observedAuthorityState(authority, now);
          return <StatusBadge state={badgeState(state)} label={t(AUTHORITY_STATE_KEYS[state])} />;
        },
        { width: "w-[34%]" },
      ),
    ];
  }, [t, dateTime, locale, versions, now]);
  return (
    <>
      <RecordTable
        columns={columns}
        data={[...items]}
        collectionId={collectionId}
        emptyLine={emptyLine}
        onOpen={(authority) => setOpen(authority)}
        rowLabel={(authority) => authorityHeadline(authority, t, locale)}
        rowActions={
          automation.canWrite
            ? (authority, index) =>
                authority.revoked_at ? null : (
                  <span data-action-scope="approval" data-testid={rowTestId(index)}>
                    <RevokeApproval
                      authority={authority}
                      versionText={
                        authorityVersionLabel(authority.workflow_version_id, versions).text
                      }
                      testId={rowTestId(index)}
                    />
                  </span>
                )
            : undefined
        }
      />
      {open ? (
        <ApprovalSheet
          authority={open}
          versions={versions}
          now={now}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/**
 * "Freigaben" (V4d): the approvals a run can use now, each revocable, and the
 * former ones folded. Approving lives in the strip only.
 */
export function WorkflowApprovals({ automation }: { automation: WorkflowAutomation }) {
  const { t, locale } = useI18n();
  const { state } = automation;
  const current: WorkflowAuthority[] = state
    ? state.grant
      ? [state.grant, ...state.alsoValid]
      : state.alsoValid
    : [];
  const history = state?.history ?? [];
  const summary = state?.grant
    ? t("workflowApprovals.current", { boundary: authorityHeadline(state.grant, t, locale) })
    : current.length > 0
      ? t("workflowApprovals.elsewhere", { count: current.length })
      : t("workflowApprovals.none");
  return (
    <>
      <SummaryLine text={summary} testId="workflow-approvals-summary" />
      {state ? (
        <ApprovalsBody automation={automation} current={current} history={history} />
      ) : (
        <DataState state="loading" testId="workflow-approvals-loading" />
      )}
    </>
  );
}

function ApprovalsBody({
  automation,
  current,
  history,
}: {
  automation: WorkflowAutomation;
  current: WorkflowAuthority[];
  history: WorkflowAuthority[];
}) {
  const { t } = useI18n();
  return (
    <>
      <ApprovalTable
        items={current}
        automation={automation}
        collectionId="workflow-approvals"
        rowTestId={(index) =>
          index === 0 && automation.state?.grant ? "authority-current" : `authority-valid-${index}`
        }
        emptyLine={t("workflowApprovals.none")}
      />
      {history.length > 0 || automation.history.hasMore ? (
        <CollapsibleSection
          label={t("automation.formerGrants")}
          count={history.length}
          testId="workflow-former-grants"
        >
          <ApprovalTable
            items={history}
            automation={automation}
            collectionId="workflow-former-approvals"
            rowTestId={(index) => `authority-history-${index}`}
            emptyLine={t("workflowApprovals.none")}
          />
          {automation.history.hasMore ? (
            <ActionMenu
              items={[
                {
                  label: t("authority.more"),
                  disabled: automation.history.loading,
                  onSelect: automation.history.more,
                  testId: "authority-more",
                },
              ]}
            />
          ) : null}
        </CollapsibleSection>
      ) : null}
    </>
  );
}
