import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import {
  approveSkillCandidates,
  listProposedSkillCandidates,
  rejectSkillCandidate,
} from "@/api/decisions";
import { useActorDirectory } from "@/app/actor-directory";
import { type ActorDirectory, actorLabel } from "@/app/actor-directory-model";
import { useLiveQueryOptions } from "@/app/live-events";
import {
  Button,
  type CockpitColumn,
  ConfirmDialog,
  DataTable,
  Page,
  PageHeader,
  StatusBadge,
  StatusStrip,
  type TableSelection,
} from "@/components/cockpit/patterns";
import { keepSelectable } from "@/components/cockpit/patterns/table-selection";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { ORIGIN_LABEL, skillDecision } from "@/pages/decisions-model";
import {
  approvalSummary,
  type CandidateRow,
  candidateExcerpt,
  candidateRows,
  type DecidedCandidate,
  type DecisionSummary,
  rejectionSummary,
  selectableCandidate,
  withDecisions,
} from "@/pages/skill-candidates-model";
import { isDetectedPattern, mayApproveProposal } from "@/pages/skill-proposal-model";
import { SkillProposalSheet } from "@/pages/skill-proposal-sheet";
import { skillScopeKey } from "@/pages/skills-model";

type Translate = ReturnType<typeof useI18n>["t"];

const PROPOSALS_KEY = ["skill-candidates", "proposed"];

function rowStatus(row: CandidateRow, t: Translate) {
  if (row.status === "approved")
    return <StatusBadge state="approved" label={t("skillCandidates.state.approved")} />;
  if (row.status === "rejected")
    return <StatusBadge state="rejected" label={t("skillCandidates.state.rejected")} />;
  return <StatusBadge state="proposed" label={t("skills.state.proposed")} />;
}

function sourceLine(row: CandidateRow, directory: ActorDirectory, t: Translate): string {
  const origin = t(ORIGIN_LABEL[skillDecision(row.candidate).origin]);
  const author = actorLabel(directory, row.candidate.proposed_by, t);
  return author ? `${origin} · ${t("proposal.by", { name: author })}` : origin;
}

export function SkillCandidatesView({
  rows,
  permissions,
  directory,
  selected,
  onSelect,
  summary,
  deciding,
  pending,
  failed,
  onRetry,
  onApprove,
  onDiscard,
  onOpen,
}: {
  rows: readonly CandidateRow[];
  permissions: readonly string[];
  directory: ActorDirectory;
  selected: ReadonlySet<string>;
  onSelect(next: ReadonlySet<string>): void;
  summary: DecisionSummary | null;
  deciding: "approve" | "discard" | null;
  pending: boolean;
  failed: boolean;
  onRetry(): void;
  onApprove(): void;
  onDiscard(): Promise<void>;
  onOpen(row: CandidateRow): void;
}) {
  const { t, tn, dateTime } = useI18n();
  const [discarding, setDiscarding] = useState(false);
  const hidden = t("tool.referenceHiddenInline");
  const canWrite = permissions.includes("skill:write");
  const canApprove = mayApproveProposal(permissions);
  const [sorting, setSorting] = useState<SortingState>([]);
  const chosen = rows.filter(
    (row) => selected.has(row.candidate.id) && selectableCandidate(row),
  ).length;

  const columns = useMemo<CockpitColumn<CandidateRow>[]>(() => {
    const column = tableColumns<CandidateRow>({ t, dateTime });
    return [
      column.custom(
        "candidate",
        (row) => row.candidate.title,
        t("skillCandidates.column.candidate"),
        (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">
              {hideTechnicalIdentifiers(row.candidate.title, hidden)}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {t(skillScopeKey(row.candidate.scope))}
            </span>
          </span>
        ),
        { width: "w-[28%]" },
      ),
      column.custom(
        "excerpt",
        (row) => row.candidate.body,
        t("skillCandidates.column.excerpt"),
        (row) => (
          <span
            className="line-clamp-2 block rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
            data-slot="candidate-excerpt"
          >
            {hideTechnicalIdentifiers(candidateExcerpt(row.candidate), hidden)}
          </span>
        ),
        { width: "w-[38%]" },
      ),
      {
        ...column.custom(
          "source",
          (row) => row.candidate.pattern_kind,
          t("skillCandidates.column.source"),
          (row) => <span className="line-clamp-2">{sourceLine(row, directory, t)}</span>,
          { width: "w-[20%]" },
        ),
        meta: { width: "w-[20%]", priority: "low" },
      },
      column.custom(
        "status",
        (row) => row.status,
        t("resource.field.status"),
        (row) => rowStatus(row, t),
        { width: "w-[14%]" },
      ),
    ];
  }, [t, dateTime, directory, hidden]);

  const bar =
    canWrite && chosen > 0 ? (
      <section
        aria-label={t("skillCandidates.selection")}
        className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        data-testid="skill-candidates-bulk"
      >
        <span className="me-auto font-medium" data-testid="skill-candidates-selected">
          {tn("skillCandidates.selected", chosen)}
        </span>
        {canApprove ? (
          <Button
            size="sm"
            pending={deciding === "approve"}
            disabled={deciding !== null}
            onClick={onApprove}
            data-testid="skill-candidates-approve"
          >
            {t("skills.accept")}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={deciding !== null}
          onClick={() => setDiscarding(true)}
          data-testid="skill-candidates-discard"
        >
          {t("skillCandidates.discard")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={deciding !== null}
          onClick={() => onSelect(new Set())}
          data-testid="skill-candidates-clear"
        >
          {t("skillCandidates.clearSelection")}
        </Button>
      </section>
    ) : null;

  const selection: TableSelection<CandidateRow> | undefined = canWrite
    ? {
        selected,
        onChange: onSelect,
        canSelect: selectableCandidate,
        rowLabel: (row) =>
          t("skillCandidates.selectOne", {
            name: hideTechnicalIdentifiers(row.candidate.title, hidden),
          }),
        allLabel: t("skillCandidates.selectAll"),
        bar,
      }
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground" data-testid="skill-candidates-footnote">
        {t("skillCandidates.footnote")}
      </p>
      {summary && summary.decided.length > 0 ? (
        <StatusStrip
          tone="ok"
          line={tn(
            summary.decision === "approved"
              ? "skillCandidates.approved"
              : "skillCandidates.rejected",
            summary.decided.length,
          )}
          testId="skill-candidates-decided"
        />
      ) : null}
      {summary && summary.skipped > 0 ? (
        <StatusStrip
          tone="warn"
          line={tn("skillCandidates.skipped", summary.skipped)}
          testId="skill-candidates-skipped"
        />
      ) : null}
      <DataTable
        columns={columns}
        data={[...rows]}
        sorting={sorting}
        onSortingChange={setSorting}
        getRowId={(row) => row.candidate.id}
        selection={selection}
        pending={pending}
        error={
          failed
            ? {
                title: t("resource.loadFailed", { resource: t("skillCandidates.title") }),
                description: t("resource.loadFailedDescription"),
                retryLabel: t("session.retry"),
                onRetry,
              }
            : null
        }
        emptyState={{
          zero: { title: t("skillCandidates.empty") },
          filtered: {
            title: t("resource.noMatches"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset: () => {},
          },
        }}
        hasActiveFilters={false}
        canOpen={(row) => row.status === "proposed"}
        onOpen={onOpen}
        rowLabel={(row) =>
          t("skills.openProposal", {
            name: hideTechnicalIdentifiers(row.candidate.title, hidden),
          })
        }
        columnsLabel={t("catalog.columns")}
        actionsLabel={t("common.actions")}
        showDefaultSearch={false}
        pickColumns={false}
        collectionId="skill-candidates"
      />
      <ConfirmDialog
        open={discarding}
        onOpenChange={(open) => deciding === null && setDiscarding(open)}
        object={tn("skillCandidates.object", chosen)}
        verb={t("skillCandidates.discard")}
        consequence={tn("skillCandidates.discardConsequence", chosen)}
        destructive
        pending={deciding === "discard"}
        onConfirm={() => onDiscard().then(() => setDiscarding(false))}
        testId="skill-candidates-discard-confirm"
      />
    </div>
  );
}

export function SkillCandidatesHeader() {
  const { t } = useI18n();
  return (
    <PageHeader
      title={t("skillCandidates.title")}
      back={{ to: "/skills", label: t("skillCandidates.back") }}
      purpose={t("skillCandidates.intro")}
    />
  );
}

export function SkillCandidatesPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const canRead = permissions.includes("skill:read");
  const proposals = useQuery({
    queryKey: PROPOSALS_KEY,
    queryFn: () => listProposedSkillCandidates(),
    enabled: canRead,
    ...live,
  });
  const open = (proposals.data?.items ?? []).filter(isDetectedPattern);
  const directory = useActorDirectory(canRead && open.length > 0);
  const [decided, setDecided] = useState<ReadonlyMap<string, DecidedCandidate>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = candidateRows(open, decided);
  const chosen = rows.filter((row) => selected.has(row.candidate.id) && selectableCandidate(row));

  const settle = (next: DecisionSummary) => {
    setDecided((current) => withDecisions(current, rows, next));
    setSummary(next);
    setSelected((current) =>
      keepSelectable(
        rows
          .filter((row) => selectableCandidate(row) && !next.decided.includes(row.candidate.id))
          .map((row) => row.candidate.id),
        current,
      ),
    );
    void client.invalidateQueries({ queryKey: PROPOSALS_KEY });
    void client.invalidateQueries({ queryKey: ["catalog"] });
    void client.invalidateQueries({ queryKey: ["decisions"] });
    void client.invalidateQueries({ queryKey: ["attention"] });
  };

  const approve = useMutation({
    mutationFn: () =>
      approveSkillCandidates(
        chosen.map((row) => ({
          id: row.candidate.id,
          expected_review_digest: row.candidate.review_digest ?? "",
        })),
      ),
    onSuccess: (result) => settle(approvalSummary(result.results)),
  });
  const discard = useMutation({
    mutationFn: async () => {
      const outcomes: { id: string; rejected: boolean }[] = [];
      for (const row of chosen) {
        try {
          await rejectSkillCandidate(row.candidate.id, t("skills.rejectReason"));
          outcomes.push({ id: row.candidate.id, rejected: true });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          outcomes.push({ id: row.candidate.id, rejected: false });
        }
      }
      return outcomes;
    },
    onSuccess: (outcomes) => settle(rejectionSummary(outcomes)),
  });
  const failure = approve.error ?? discard.error;
  const header = <SkillCandidatesHeader />;
  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="skill-candidates-page"
        header={header}
      >
        <ForbiddenState />
      </Page>
    );
  const opened = open.find((candidate) => candidate.id === openId) ?? null;
  return (
    <Page
      kind="list"
      surface="collection"
      scroll="page"
      testId="skill-candidates-page"
      header={header}
    >
      {failure ? (
        <StatusStrip
          tone="error"
          line={t("common.actionFailed")}
          testId="skill-candidates-failed"
        />
      ) : null}
      <SkillCandidatesView
        rows={rows}
        permissions={permissions}
        directory={directory}
        selected={selected}
        onSelect={(next) => {
          setSelected(next);
          approve.reset();
          discard.reset();
        }}
        summary={summary}
        deciding={approve.isPending ? "approve" : discard.isPending ? "discard" : null}
        pending={proposals.isPending}
        failed={proposals.isError}
        onRetry={() => void proposals.refetch()}
        onApprove={() => approve.mutate()}
        onDiscard={() =>
          discard.mutateAsync().then(
            () => undefined,
            () => undefined,
          )
        }
        onOpen={(row) => setOpenId(row.candidate.id)}
      />
      <SkillProposalSheet
        candidate={opened && !decided.has(opened.id) ? opened : null}
        permissions={permissions}
        onClose={() => setOpenId(null)}
        onDecided={() => {
          void client.invalidateQueries({ queryKey: PROPOSALS_KEY });
          void client.invalidateQueries({ queryKey: ["catalog"] });
          void client.invalidateQueries({ queryKey: ["decisions"] });
          void client.invalidateQueries({ queryKey: ["attention"] });
        }}
      />
    </Page>
  );
}
