import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ConfirmDialog } from "@ui/components/proto/ConfirmDialog";
import { ErrorNotice, ErrorState, FieldError } from "@ui/components/proto/ErrorNotice";
import { MarkdownDocument } from "@ui/components/proto/MarkdownDocument";
import { MarkdownEditor } from "@ui/components/proto/MarkdownEditor";
import { PageHeader } from "@ui/components/proto/Pill";
import { EmptyState, IconTile, StatusStrip } from "@ui/components/proto/visual";
import { Checkbox } from "@ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/components/ui/dialog";
import { DropdownMenuItem } from "@ui/components/ui/dropdown-menu";
import { listPageFailure } from "@ui/lib/errors";
import { cn } from "@ui/lib/utils";
import { ArrowLeft, Check, FileText, Pencil, Plus, Power, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import {
  approveSkillCandidates,
  listProposedSkillCandidates,
  rejectSkillCandidate,
} from "@/api/decisions";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName, actorLabel } from "@/app/actor-directory-model";
import { recordHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useDirtyGuard } from "@/app/version-notice";
import { CatalogPurpose } from "@/components/cockpit/catalog-metadata";
import { Button, Input, Label } from "@/components/cockpit/patterns/controls";
import { dialogWidthClass } from "@/components/cockpit/patterns/dialog-frame";
import { Measured } from "@/components/cockpit/patterns/measure";
import { tabFromSearch } from "@/components/cockpit/patterns/page-tabs";
import { usePageFailure } from "@/components/cockpit/patterns/use-error-detail";
import { SkillProposalSheet } from "@/components/cockpit/skill-proposal-sheet";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { keptVersionCount } from "@/lib/knowledge-versions-model";
import { plural } from "@/lib/plural";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
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
} from "@/lib/skill-candidates-model";
import { isDetectedPattern, mayApproveProposal } from "@/lib/skill-proposal-model";
import { skillHistoryGap, skillScopeKey, skillVersionRows } from "@/lib/skills-model";
import { humanizeCategory } from "@/lib/workflow-category";
import { categoryCounts, createdByMatches, sortRows } from "./list-model";
import {
  groupBy,
  matches,
  SCOPE_APPLIES,
  SKILL_TONE,
  type SkillScopeView,
  type SkillView,
  skillDraftChanges,
  skillDraftErrors,
  skillView,
} from "./model";
import { KEYS, useMarkdownRefs, useRefreshKnowledge, useSkills } from "./queries";
import {
  ChatMenu,
  ConfirmDelete,
  DetailShell,
  GroupedTable,
  type Head,
  ListSkeleton,
  ListSummary,
  Loaded,
  NameCell,
  NoMatch,
  OnboardingCard,
  Row,
  StatusCell,
  Toolbar,
  UsageList,
  useColumnChoice,
  useListState,
  useMetadataMenu,
  usePageMenu,
  useRel,
  VersionsTab,
} from "./shell";
import { useRecordUses } from "./uses";

type Skill = NonNullable<ReturnType<typeof useSkills>["data"]>["items"][number];
const STATUS_KEY = {
  active: "kn.status.active",
  off: "kn.status.off",
  draft: "kn.skills.status.draft",
} as const;
const SCOPE_KEY = {
  chat: "kn.skills.scope.chat",
  drafts: "kn.skills.scope.drafts",
  both: "kn.skills.scope.both",
} as const;
const BINDING_KEY = {
  global: "kn.skills.binding.global",
  connector: "kn.skills.binding.connector",
  workflow: "kn.skills.binding.workflow",
} as const;
const TEMPLATES = ["tone", "report", "errors", "company"] as const;
const PROMPTS = [
  "kn.skills.prompt.derive",
  "kn.skills.prompt.contradictions",
  "kn.skills.prompt.summarize",
] as const;
const CANDIDATES_KEY = ["skill-candidates", "proposed"];

function useCandidates(enabled: boolean) {
  return useQuery({
    queryKey: CANDIDATES_KEY,
    queryFn: () => listProposedSkillCandidates(),
    enabled,
  });
}

type Draft = { name: string; body: string; scope: SkillScopeView };

function useCreateSkill() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const refresh = useRefreshKnowledge();
  return useMutation({
    mutationFn: (d: Draft) =>
      apiCall("post", "/v1/skills", {
        body: {
          scope: "global",
          title: d.name.trim(),
          body: d.body,
          applies_to: SCOPE_APPLIES[d.scope],
          status: "active",
          source: "manual",
        },
      }),
    onSuccess: (s) => {
      toast.success(t("kn.skills.created", { name: s.title }));
      void refresh();
      void navigate({ to: recordHref("skills", s.id) });
    },
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
}

const SKILL_SORT: Record<string, (x: SkillView) => string | number> = {
  name: (x) => x.name,
  status: (x) => x.status,
  applies: (x) => x.binding,
  scope: (x) => x.scope,
  changed: (x) => x.changed,
};

export function SkillsPage({ creating = false }: { creating?: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const canWrite = session.permissions.includes("skill:write");
  const st = useListState();
  const rel = useRel();
  const create = useCreateSkill();
  const menu = usePageMenu({ pkg: "skill", categories: "skill", category: st.cat });
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const [templateKey] = useState(() => {
    const k = tabFromSearch(search, "template", TEMPLATES, "");
    return k ? (k as (typeof TEMPLATES)[number]) : null;
  });
  const [editing, setEditing] = useState(creating || templateKey !== null);
  const query = useSkills();
  const candidates = useCandidates(session.permissions.includes("skill:read"));
  const open = (candidates.data?.items ?? []).filter(isDetectedPattern).length;
  const views = useMemo(() => (query.data?.items ?? []).map(skillView), [query.data]);
  const other = t("catalog.categoryOther");
  const items = sortRows(
    views.filter(
      (x) =>
        (st.cat === "all" || x.category === st.cat) &&
        createdByMatches(x.describedBy, st.createdBy) &&
        matches(st.q, x.name, x.body, x.category),
    ),
    SKILL_SORT[st.sort.key] ?? null,
    st.sort.order,
  );
  const key =
    st.group === "category"
      ? (x: SkillView) => humanizeCategory(x.category, other)
      : st.group === "status"
        ? (x: SkillView) => t(STATUS_KEY[x.status])
        : st.group === "scope"
          ? (x: SkillView) => t(SCOPE_KEY[x.scope])
          : null;
  const head: Head[] = [
    { label: t("kn.skills.col.skill"), sort: "name" },
    { label: t("kn.col.status"), sort: "status" },
    { label: t("kn.skills.col.applies"), sort: "applies" },
    { label: t("kn.skills.col.scope"), sort: "scope", priority: "low" },
    { label: t("kn.col.changed"), sort: "changed", priority: "low" },
  ];
  const columns = useColumnChoice(head);
  const template = (k: (typeof TEMPLATES)[number]): Draft => ({
    name: t(`kn.skills.template.${k}.name`),
    body: t(`kn.skills.template.${k}.body`),
    scope: "both",
  });
  const failure = usePageFailure(
    listPageFailure({
      failed: query.isError,
      loaded: query.data !== undefined,
      onRetry: () => void query.refetch(),
      error: query.error,
      collectionId: "kn",
    }),
  );
  if (failure) return <ErrorState {...failure} heading="h1" />;
  return (
    <div>
      <PageHeader
        title={t("kn.skills.title")}
        lead={t("kn.skills.lead")}
        actions={
          <div className="flex items-center gap-2">
            <ChatMenu items={menu.items} prompts={PROMPTS.map((k) => t(k))} />
            {canWrite && (
              <Button data-testid="kn-skills-create" onClick={() => setEditing(true)}>
                <Plus className="size-4" aria-hidden />
                {t("kn.skills.create")}
              </Button>
            )}
          </div>
        }
      />
      {open > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <Button
            data-testid="kn-skills-openSuggestions"
            variant="link"
            className="h-auto px-0"
            onClick={() => void navigate({ to: "/skills/candidates" })}
          >
            <Sparkles className="size-4" aria-hidden />
            {plural(t, "kn.skills.openSuggestions", open)}
          </Button>
        </div>
      )}
      {query.data && views.length === 0 && (
        <OnboardingCard
          icon={Sparkles}
          title={t("kn.skills.onboardTitle")}
          text={t("kn.skills.onboardText")}
        >
          {canWrite &&
            TEMPLATES.map((k) => (
              <Button
                data-testid="kn-skills-template"
                key={k}
                size="sm"
                variant="outline"
                disabled={create.isPending}
                onClick={() => create.mutate(template(k))}
              >
                <FileText className="size-4" aria-hidden />
                {t(`kn.skills.template.${k}.name`)}
              </Button>
            ))}
        </OnboardingCard>
      )}
      <Loaded query={query}>
        {() => (
          <>
            <Toolbar
              st={st}
              groups={["category", "status", "scope"]}
              categories={categoryCounts(views)}
              createdBy
              columns={columns}
            />
            <ListSummary
              testId="kn-skills-summary"
              kind="skill"
              parts={[plural(t, "kn.skills.count", items.length)]}
            />
            {items.length ? (
              <GroupedTable
                head={head}
                hidden={columns.hidden}
                sort={st.sort}
                onSort={st.sortBy}
                groups={groupBy(items, key)}
                row={(x) => (
                  <Row
                    key={x.id}
                    onOpen={() => void navigate({ to: recordHref("skills", x.id) })}
                    label={x.name}
                  >
                    <td>
                      <NameCell
                        icon={<IconTile icon={Sparkles} size="sm" />}
                        title={x.name}
                        sub={`${humanizeCategory(x.category, other)} · v${x.version}`}
                      />
                    </td>
                    <td>
                      <StatusCell tone={SKILL_TONE[x.status]} label={t(STATUS_KEY[x.status])} />
                    </td>
                    <td>{t(BINDING_KEY[x.binding])}</td>
                    <td>{t(SCOPE_KEY[x.scope])}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{rel(x.changed)}</td>
                  </Row>
                )}
              />
            ) : views.length ? (
              <NoMatch onReset={st.reset} />
            ) : null}
          </>
        )}
      </Loaded>
      {menu.dialogs}
      <SkillEditor
        open={editing}
        onOpenChange={setEditing}
        {...(templateKey ? { initial: template(templateKey), fresh: true } : {})}
        busy={create.isPending}
        onSave={(d) => {
          create.mutate(d);
          setEditing(false);
        }}
      />
    </div>
  );
}

export function SkillCandidatesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const directory = useActorDirectory(true);
  const canWrite = session.permissions.includes("skill:write");
  const canApprove = mayApproveProposal(session.permissions);
  const query = useCandidates(true);
  const [decided, setDecided] = useState<Map<string, DecidedCandidate>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = (query.data?.items ?? []).filter(isDetectedPattern);
  const rows = candidateRows(open, decided);
  const chosen = rows.filter((r) => selected.has(r.candidate.id) && selectableCandidate(r));
  const hidden = t("tool.referenceHiddenInline");
  const settle = (result: DecisionSummary) => {
    setDecided((d) => withDecisions(d, rows, result));
    setSelected(new Set());
    setSummary(result);
    void client.invalidateQueries({ queryKey: CANDIDATES_KEY });
    void client.invalidateQueries({ queryKey: ["catalog"] });
    void client.invalidateQueries({ queryKey: ["decisions"] });
    void client.invalidateQueries({ queryKey: ["attention"] });
  };
  const approve = useMutation({
    mutationFn: (list: CandidateRow[]) =>
      approveSkillCandidates(
        list.map((r) => ({
          id: r.candidate.id,
          expected_review_digest: r.candidate.review_digest ?? "",
        })),
      ),
    onSuccess: (r) => settle(approvalSummary(r.results)),
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
  const reject = useMutation({
    mutationFn: async (list: CandidateRow[]) => {
      const outcomes: { id: string; rejected: boolean }[] = [];
      for (const r of list) {
        try {
          outcomes.push(
            await rejectSkillCandidate(r.candidate.id, t("kn.skills.dropReason")).then((x) => ({
              id: r.candidate.id,
              rejected: x.rejected,
            })),
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 409)
            outcomes.push({ id: r.candidate.id, rejected: false });
          else throw error;
        }
      }
      return outcomes;
    },
    onSuccess: (outcomes) => settle(rejectionSummary(outcomes)),
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectable = rows.filter(selectableCandidate);
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.candidate.id));
  const STATUS = {
    proposed: ["info", "kn.skills.cand.proposed"],
    approved: ["success", "kn.skills.cand.approved"],
    rejected: ["neutral", "kn.skills.cand.rejected"],
  } as const;
  const failure = usePageFailure(
    listPageFailure({
      failed: query.isError,
      loaded: query.data !== undefined,
      onRetry: () => void query.refetch(),
      error: query.error,
      collectionId: "kn",
    }),
  );
  if (failure) return <ErrorState {...failure} heading="h1" />;
  return (
    <div>
      <Button
        data-testid="kn-skills-title"
        variant="ghost"
        size="sm"
        className="-ml-3 mb-3"
        onClick={() => void navigate({ to: "/skills" })}
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("kn.skills.title")}
      </Button>
      <PageHeader title={t("kn.skills.candidates")} lead={t("kn.skills.candidatesLead")} />
      {summary && (
        <StatusStrip tone={summary.skipped ? "warning" : "success"}>
          {t(
            summary.decision === "approved"
              ? "kn.skills.cand.approvedN"
              : "kn.skills.cand.rejectedN",
            {
              n: summary.decided.length,
            },
          )}
          {summary.skipped ? ` · ${t("kn.skills.cand.skippedN", { n: summary.skipped })}` : ""}
        </StatusStrip>
      )}
      {canWrite && chosen.length > 0 && (
        <section
          aria-label={t("kn.skills.cand.selection")}
          data-testid="kn-skills-bulk"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <span className="mr-auto">{t("kn.skills.cand.chosen", { n: chosen.length })}</span>
          <Button
            data-testid="kn-skills-bulk-clear"
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            {t("kn.skills.cand.clear")}
          </Button>
          <Button
            data-testid="kn-skills-bulk-drop"
            size="sm"
            variant="outline"
            disabled={reject.isPending}
            onClick={() => setConfirm("reject")}
          >
            <X className="size-4" aria-hidden />
            {t("kn.skills.drop")}
          </Button>
          {canApprove && (
            <Button
              data-testid="kn-skills-bulk-accept"
              size="sm"
              disabled={approve.isPending}
              onClick={() => setConfirm("approve")}
            >
              <Check className="size-4" aria-hidden />
              {t("kn.skills.accept")}
            </Button>
          )}
        </section>
      )}
      <Loaded query={query}>
        {() =>
          rows.length ? (
            <GroupedTable
              head={[
                "",
                t("kn.skills.cand.candidate"),
                t("kn.skills.cand.excerpt"),
                t("kn.skills.cand.source"),
                t("kn.col.status"),
              ]}
              groups={[["", rows]]}
              row={(r) => {
                const x = r.candidate;
                const [tone, label] = STATUS[r.status];
                return (
                  <Row
                    key={x.id}
                    testId="kn-skills-candidate"
                    label={hideTechnicalIdentifiers(x.title, hidden)}
                    onOpen={() => setOpenId(x.id)}
                  >
                    <td className="w-10">
                      {canWrite && selectableCandidate(r) && (
                        <Checkbox
                          data-testid="kn-skills-select"
                          aria-label={x.title}
                          checked={selected.has(x.id)}
                          onClick={(ev) => ev.stopPropagation()}
                          onCheckedChange={(v) => toggle(x.id, v === true)}
                        />
                      )}
                    </td>
                    <td>
                      <NameCell
                        icon={<IconTile icon={Sparkles} size="sm" tone="info" />}
                        title={hideTechnicalIdentifiers(x.title, hidden)}
                        sub={t(skillScopeKey(x.scope))}
                      />
                    </td>
                    <td className="text-muted-foreground">
                      <Measured measure="excerpt">
                        {hideTechnicalIdentifiers(candidateExcerpt(x), hidden)}
                      </Measured>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {[
                        t("kn.skills.evidenceN", { n: x.evidence_count }),
                        actorLabel(directory, x.proposed_by, t),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                    <td>
                      <StatusCell tone={tone} label={t(label)} />
                    </td>
                  </Row>
                );
              }}
            />
          ) : (
            <EmptyState icon={Sparkles} title={t("kn.skills.noCandidates")} />
          )
        }
      </Loaded>
      {canWrite && selectable.length > 1 && (
        <Button
          data-testid="kn-skills-select-all"
          size="sm"
          variant="ghost"
          className="mt-3"
          onClick={() =>
            setSelected(allOn ? new Set() : new Set(selectable.map((r) => r.candidate.id)))
          }
        >
          {t(allOn ? "kn.skills.cand.clear" : "kn.skills.cand.selectAll")}
        </Button>
      )}
      <SkillProposalSheet
        candidate={
          rows.find((r) => r.candidate.id === openId && r.status === "proposed")?.candidate ?? null
        }
        permissions={session.permissions}
        onClose={() => setOpenId(null)}
        onDecided={() => {
          setOpenId(null);
          void client.invalidateQueries({ queryKey: CANDIDATES_KEY });
          void client.invalidateQueries({ queryKey: ["catalog"] });
          void client.invalidateQueries({ queryKey: ["decisions"] });
          void client.invalidateQueries({ queryKey: ["attention"] });
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={t(
          confirm === "approve" ? "kn.skills.cand.approveTitle" : "kn.skills.cand.rejectTitle",
          {
            n: chosen.length,
          },
        )}
        body={t(confirm === "approve" ? "kn.skills.cand.approveBody" : "kn.skills.cand.rejectBody")}
        action={t(confirm === "approve" ? "kn.skills.accept" : "kn.skills.drop")}
        onConfirm={() => {
          if (confirm === "approve") approve.mutate(chosen);
          else reject.mutate(chosen);
          setConfirm(null);
        }}
      />
    </div>
  );
}

function SkillEditor({
  open,
  onOpenChange,
  onSave,
  initial,
  fresh = false,
  busy,
  conflict,
  onReload,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (d: Draft) => void;
  initial?: Draft;
  fresh?: boolean;
  busy?: boolean;
  conflict?: boolean;
  onReload?: () => Draft;
}) {
  const { t } = useI18n();
  const refs = useMarkdownRefs();
  const blank: Draft = { name: "", body: "", scope: "both" };
  const [f, setF] = useState<Draft>(initial ?? blank);
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState("");
  const [leaving, setLeaving] = useState(false);
  const errs = skillDraftErrors(f);
  const changes = skillDraftChanges(f, initial ?? blank);
  useDirtyGuard(open && changes > 0);
  const close = () => (changes > 0 ? setLeaving(true) : onOpenChange(false));
  const submit = () => {
    setTried(true);
    if (errs.name || errs.body) return;
    onSave({ ...f, name: f.name.trim() });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) return close();
        setF(initial ?? blank);
        setTried(false);
        setNote("");
        onOpenChange(v);
      }}
    >
      <DialogContent className={dialogWidthClass("document")}>
        <DialogHeader>
          <DialogTitle>
            {initial && !fresh ? t("kn.skills.editTitle") : t("kn.skills.create")}
          </DialogTitle>
          <DialogDescription>{t("kn.skills.editHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <Label htmlFor="sk-name">{t("kn.name")}</Label>
              <Input
                data-testid="sk-name"
                id="sk-name"
                className="mt-2"
                placeholder={t("kn.skills.namePh")}
                value={f.name}
                aria-invalid={(tried && errs.name) || undefined}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
              {tried && errs.name && <FieldError>{t("kn.skills.errName")}</FieldError>}
            </div>
            <fieldset className="m-0 min-w-0">
              <legend className="text-sm font-medium">{t("kn.skills.col.scope")}</legend>
              <div className="mt-2 inline-flex h-10 rounded-control border p-0.5">
                {(["chat", "drafts", "both"] as SkillScopeView[]).map((x) => (
                  <button
                    data-testid="kn-skills-scope"
                    key={x}
                    type="button"
                    aria-pressed={f.scope === x}
                    onClick={() => setF({ ...f, scope: x })}
                    className={cn(
                      "rounded-[6px] px-3 text-sm",
                      f.scope === x
                        ? "bg-secondary font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(SCOPE_KEY[x])}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          {(!initial || fresh) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("kn.skills.templates")}</span>
              {TEMPLATES.map((k) => (
                <Button
                  data-testid="kn-skills-editor-template"
                  key={k}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() =>
                    setF({
                      ...f,
                      name: f.name || t(`kn.skills.template.${k}.name`),
                      body: t(`kn.skills.template.${k}.body`),
                    })
                  }
                >
                  <FileText className="size-4" aria-hidden />
                  {t(`kn.skills.template.${k}.name`)}
                </Button>
              ))}
            </div>
          )}
          <div>
            <Label htmlFor="sk-body" className="mb-2 block">
              {t("kn.skills.rules")}
            </Label>
            <MarkdownEditor
              id="sk-body"
              value={f.body}
              onChange={(body) => setF({ ...f, body })}
              invalid={tried && errs.body}
              refs={refs}
            />
            {tried && errs.body && <FieldError>{t("kn.skills.errBody")}</FieldError>}
          </div>
          {conflict && onReload && (
            <ErrorNotice
              kind="skillConflict"
              tone="warning"
              rows={[]}
              primary={{
                label: t("kn.skills.reload"),
                onClick: () => {
                  setF(onReload());
                  setNote(t("kn.skills.reloaded"));
                },
              }}
            />
          )}
          {note && (
            <p role="status" className="text-sm text-muted-foreground">
              {note}
            </p>
          )}
          <DialogFooter>
            <Button data-testid="common-cancel" type="button" variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button data-testid="kn-save" type="submit" disabled={busy}>
              {t("kn.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t("kn.discardTitle")}
        body={t(changes === 1 ? "pattern.saveBar.unsaved.one" : "pattern.saveBar.unsaved", {
          count: changes,
        })}
        action={t("common.discard")}
        onConfirm={() => {
          setLeaving(false);
          setF(initial ?? blank);
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}

export function SkillPage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: KEYS.skill(id),
    queryFn: () => apiCall("get", "/v1/skills/{id}", { path: { id } }),
  });
  if (!query.data && !query.isError) return <ListSkeleton />;
  return <Loaded query={query}>{(sk) => <SkillDetail key={sk.id} sk={sk} />}</Loaded>;
}

function SkillDetail({ sk }: { sk: Skill }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const refresh = useRefreshKnowledge();
  const rel = useRel();
  const directory = useActorDirectory(true);
  const v = skillView(sk);
  const canWrite = session.permissions.includes("skill:write");
  const canActivate = session.permissions.includes("skill:activate");
  const canArchive = session.permissions.includes("skill:archive");
  const canDelete = session.permissions.includes("skill:delete");
  const meta = useMetadataMenu({
    kind: "skill",
    id: sk.id,
    record: sk,
    queryKey: KEYS.skill(sk.id),
    nameKey: "title",
  });
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const [editing, setEditing] = useState(
    () => canWrite && new URLSearchParams(search).get("mode") === "edit",
  );
  const [conflict, setConflict] = useState(false);
  const uses = useRecordUses({
    binding: { scope: sk.scope, workflowId: sk.workflow_id, connectorId: sk.connector_id },
    target: { kind: "skill", id: sk.id },
  });
  const [del, setDel] = useState(false);
  const fail = (error: unknown) => reportFailure(t("common.actionFailed"), error);
  const saved = (n: Skill) => {
    client.setQueryData(KEYS.skill(sk.id), n);
    void refresh();
    void client.invalidateQueries({ queryKey: [...KEYS.skill(sk.id), "history"] });
  };
  const on = v.status === "active";
  const toggle = useMutation({
    mutationFn: () =>
      on
        ? apiCall("post", "/v1/skills/{id}/archive", { path: { id: sk.id } })
        : apiCall("post", "/v1/skills/{id}/activate", { path: { id: sk.id } }),
    onSuccess: (n) => {
      toast.success(t(on ? "kn.turnedOff" : "kn.turnedOn", { name: v.name }));
      saved(n);
    },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: (d: Draft) =>
      apiCall("patch", "/v1/skills/{id}", {
        path: { id: sk.id },
        body: {
          title: d.name,
          body: d.body,
          applies_to: SCOPE_APPLIES[d.scope],
          expected_version: sk.version,
        },
      }),
    onSuccess: (n) => {
      toast.success(t("kn.skills.saved", { name: n.title, n: n.version }));
      saved(n);
      setConflict(false);
      setEditing(false);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else fail(error);
    },
  });
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/skills/{id}", { path: { id: sk.id } }),
    onSuccess: () => {
      toast.success(t("kn.deleted", { name: v.name }));
      void refresh();
      void navigate({ to: "/skills" });
    },
    onError: fail,
  });
  const history = useQuery({
    queryKey: [...KEYS.skill(sk.id), "history"],
    queryFn: () => apiCall("get", "/v1/skills/{id}/history", { path: { id: sk.id } }),
  });
  const restore = useMutation({
    mutationFn: (auditId: string) =>
      apiCall("post", "/v1/skills/{id}/restore", {
        path: { id: sk.id },
        body: { audit_entry_id: auditId },
      }),
    onSuccess: (n) => {
      toast.success(t("kn.restored", { n: n.version }));
      saved(n);
    },
    onError: fail,
  });
  const rows = skillVersionRows(history.data?.items ?? [], sk.version);
  const gap = history.data ? skillHistoryGap(rows, sk.version) : null;
  const kept = keptVersionCount(rows.length);
  const versions = rows
    .filter((r) => r.version !== null && r.has_snapshot)
    .map((r) => ({
      key: r.audit_entry_id,
      v: r.version ?? 0,
      by: (r.actor_id && actorDirectoryName(directory, "user", r.actor_id)) || "SubKit",
      at: r.updated_at,
      current: r.current,
    }));
  const reload = (): Draft => {
    void client.invalidateQueries({ queryKey: KEYS.skill(sk.id) });
    return { name: v.name, body: v.body, scope: v.scope };
  };
  return (
    <>
      <DetailShell
        back={t("kn.skills.title")}
        onBack={() => void navigate({ to: "/skills" })}
        icon={<IconTile icon={Sparkles} size="lg" />}
        title={v.name}
        sub={<CatalogPurpose record={sk} />}
        strip={{
          tone: SKILL_TONE[v.status],
          text: t(`kn.skills.strip.${v.status}`),
          ...(!on && canActivate
            ? {
                action: (
                  <Button
                    data-testid="kn-skills-activate"
                    size="sm"
                    variant="outline"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate()}
                  >
                    {t("kn.turnOn")}
                  </Button>
                ),
              }
            : {}),
        }}
        actions={
          canWrite ? (
            <Button data-testid="kn-skills-edit" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t("kn.edit")}
            </Button>
          ) : undefined
        }
        menu={
          <ChatMenu
            label={t("kn.detailMenu")}
            references={[{ type: "skill", id: sk.id }]}
            prompts={[t("kn.editInChat")]}
            extra={
              canWrite || canActivate || canArchive || canDelete ? (
                <>
                  {canWrite && meta.items}
                  {canWrite && (
                    <DropdownMenuItem
                      data-testid="kn-skills-edit-menu"
                      onSelect={() => setEditing(true)}
                    >
                      <Pencil className="size-4" aria-hidden />
                      {t("kn.edit")}
                    </DropdownMenuItem>
                  )}
                  {(on ? canArchive : canActivate) && (
                    <DropdownMenuItem
                      data-testid="kn-skills-toggle"
                      onSelect={() => toggle.mutate()}
                    >
                      <Power className="size-4" aria-hidden />
                      {t(on ? "kn.turnOff" : "kn.turnOn")}
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <DropdownMenuItem
                      data-testid="kn-skills-delete"
                      className="text-destructive-ink"
                      onSelect={() => setDel(true)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      {t("kn.delete")}
                    </DropdownMenuItem>
                  )}
                </>
              ) : undefined
            }
          />
        }
        tabs={[
          {
            id: "content",
            label: t("kn.tab.content"),
            content: (
              <div className="rounded-xl border p-6">
                <MarkdownDocument text={v.body} underTitle={v.name} />
              </div>
            ),
          },
          {
            id: "usage",
            label: t("kn.tab.usage"),
            content: (
              <UsageList
                uses={uses}
                empty={t(v.binding === "global" ? "kn.sources.usedEverywhere" : "kn.noUses")}
              />
            ),
          },
          {
            id: "versions",
            label: t("kn.tab.versions"),
            content: (
              <VersionsTab
                versions={versions}
                canRestore={canWrite}
                busy={restore.isPending}
                onRestore={(k) => restore.mutate(k)}
                summary={
                  history.data
                    ? t(kept === 1 ? "skills.versions.one" : "skills.versions.other", {
                        count: kept,
                      })
                    : undefined
                }
                note={
                  gap
                    ? gap.through === 1
                      ? t("skills.versions.gap.one")
                      : t("skills.versions.gap.other", { through: gap.through })
                    : null
                }
                load={async (k) => {
                  const d = await apiCall("get", "/v1/skills/{id}/history/{audit_entry_id}", {
                    path: { id: sk.id, audit_entry_id: k },
                  });
                  const after = d.after as { body?: unknown } | null;
                  return typeof after?.body === "string" ? after.body : "";
                }}
              />
            ),
          },
        ]}
        facts={[
          { label: t("kn.fact.ref"), value: sk.slug ? `@skill:${sk.slug}` : "—", mono: true },
          { label: t("kn.skills.col.applies"), value: t(BINDING_KEY[v.binding]) },
          { label: t("kn.skills.col.scope"), value: t(SCOPE_KEY[v.scope]) },
          { label: t("kn.fact.version"), value: `v${sk.version} · ${rel(v.changed)}` },
          {
            label: t("kn.col.category"),
            value: humanizeCategory(sk.category, t("catalog.categoryOther")),
          },
          { label: t("kn.fact.created"), value: dateTime(sk.created_at) },
          { label: t("kn.fact.id"), value: sk.id, mono: true },
        ]}
      />
      <SkillEditor
        open={editing}
        onOpenChange={(o) => {
          setEditing(o);
          if (!o) setConflict(false);
        }}
        initial={{ name: v.name, body: v.body, scope: v.scope }}
        busy={save.isPending}
        conflict={conflict}
        onReload={reload}
        onSave={(d) => save.mutate(d)}
      />
      {canWrite && meta.dialog}
      <ConfirmDelete
        open={del}
        onOpenChange={setDel}
        name={v.name}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
