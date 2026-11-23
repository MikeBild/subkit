import { formatBytes } from "@shared/file-kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { Checkbox } from "@ui/atoms/checkbox";
import { IconTile } from "@ui/atoms/icon-tile";
import { Panel } from "@ui/atoms/pill";
import { listPageFailure } from "@ui/lib/errors";
import { FILE_ICON } from "@ui/lib/files";
import { DropdownMenuItem } from "@ui/molecules/dropdown-menu";
import { ErrorState } from "@ui/molecules/error-notice";
import { ConfirmDialog } from "@ui/organisms/confirm-dialog";
import { dialogFailure } from "@ui/organisms/dialog-frame";
import { MarkdownDocument } from "@ui/organisms/markdown-document";
import { Timeline } from "@ui/organisms/timeline";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  ExternalLink,
  Globe,
  Inbox,
  type LucideIcon,
  MessageSquare,
  Plus,
  Sparkles,
  StickyNote,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, getConversation } from "@/api/client";
import {
  confirmIntakeProposal,
  deleteDiscardedIntakeClip,
  getIntakeClip,
  getIntakeDefaultCategory,
  type IntakeState,
  listIntakeCategories,
  rejectIntakeProposal,
  setIntakeClipState,
  setIntakeDefaultCategory,
  updateIntakeClip,
} from "@/api/intake";
import { tenantContentHref } from "@/api/tenant-context";
import { useActorDirectory } from "@/app/actor-directory";
import { actorLabel } from "@/app/actor-directory-model";
import { chatNewHref, conversationHref, recordHref, routerTarget } from "@/app/links";
import { useSession } from "@/app/session";
import { Button } from "@/components/cockpit/patterns/controls";
import { Measured } from "@/components/cockpit/patterns/measure";
import { TopPageHeader } from "@/components/cockpit/patterns/page-header";
import { searchWithTab, tabFromSearch } from "@/components/cockpit/patterns/page-tabs";
import { CollapsibleSection } from "@/components/cockpit/patterns/section";
import { usePageFailure } from "@/components/cockpit/patterns/use-error-detail";
import {
  awaitingAssistantReview,
  ENTRY_TONE,
  type EntryAttachment,
  type EntryView,
  entryStrip,
  entryView,
  groupBy,
  isOpenEntry,
  matches,
  type Origin,
} from "@/features/knowledge/model/knowledge";
import { humanizeCategory } from "@/features/workflows/model";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { plural } from "@/lib/plural";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { IntakeDefaultCategoryDialog, IntakeEditDialog, IntakeNoteDialog } from "./intake-dialogs";
import { ProposalCard } from "./intake-proposal";
import { categoryCounts, sortRows, sortValueOf, withCategory } from "./list-model";
import {
  INTAKE_ORIGINS,
  INTAKE_STATES,
  type IntakeOrigin,
  intakeConversationId,
  intakeEvents,
  intakeWriteFailureKey,
  publishedDate,
  sessionLabel,
  sessionPlace,
  sessionSnapshot,
} from "./model/intake-model";
import { KEYS, useEntries, useProposals, useRefreshKnowledge } from "./queries";
import {
  ChatMenu,
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
  useColumnChoice,
  useListState,
  usePageMenu,
  useRel,
} from "./shell";

export const ORIGIN_ICON: Record<Origin, LucideIcon> = {
  browser: Globe,
  assistant: Bot,
  note: StickyNote,
};
const STATUS_KEY = {
  collected: "kn.inbox.status.collected",
  review: "kn.inbox.status.review",
  accepted: "kn.inbox.status.accepted",
  rejected: "kn.inbox.status.rejected",
} as const;
const ORIGIN_KEY = {
  browser: "kn.inbox.origin.browser",
  assistant: "kn.inbox.origin.assistant",
  note: "kn.inbox.origin.note",
} as const;
const PROMPTS = [
  "kn.inbox.prompt.review",
  "kn.inbox.prompt.summarize",
  "kn.inbox.prompt.contradictions",
  "kn.inbox.prompt.prepare",
] as const;

function useEntryViews() {
  const entries = useEntries();
  const proposals = useProposals();
  const views = useMemo(
    () => (entries.data?.items ?? []).map((i) => entryView(i, proposals.data?.items ?? [])),
    [entries.data, proposals.data],
  );
  return { query: entries, views };
}

function FlowStrip() {
  const { t } = useI18n();
  const steps: [LucideIcon, string][] = [
    [Inbox, t("kn.inbox.flow.collect")],
    [Sparkles, t("kn.inbox.flow.suggest")],
    [CheckCircle2, t("kn.inbox.flow.confirm")],
    [BookOpen, t("kn.inbox.flow.knowledge")],
  ];
  return (
    <ol
      aria-label={t("kn.inbox.flowLabel")}
      className="mb-6 grid gap-3 rounded-xl border bg-card p-4 min-[900px]:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] min-[900px]:items-center"
    >
      {steps.flatMap(([I, step], i) => [
        <li key={step} className="flex items-center gap-3 text-sm">
          <IconTile icon={I} size="sm" tone={i === 3 ? "success" : "info"} />
          <span className="min-w-0">{step}</span>
        </li>,
        i < 3 ? (
          <ArrowRight
            key={`a${step}`}
            className="hidden size-4 text-muted-foreground min-[900px]:block"
            aria-hidden
          />
        ) : null,
      ])}
    </ol>
  );
}

const ENTRY_SORT: Record<string, (e: EntryView) => string> = {
  title: (e) => e.title,
  category: (e) => e.category,
  created: (e) => e.created,
};
type StateFilter = "all" | IntakeState;
type OriginFilter = "all" | IntakeOrigin;
const isStateFilter = (v: string): v is StateFilter =>
  v === "all" || (INTAKE_STATES as readonly string[]).includes(v);
const isOriginFilter = (v: string): v is OriginFilter =>
  v === "all" || (INTAKE_ORIGINS as readonly string[]).includes(v);

export function useIntakeCategories() {
  const { permissions } = useSession();
  const enabled = permissions.includes("intake:read");
  const categories = useQuery({
    queryKey: ["intake", "categories"],
    queryFn: () => listIntakeCategories(),
    enabled,
  });
  const fallback = useQuery({
    queryKey: ["intake", "default-category"],
    queryFn: () => getIntakeDefaultCategory(),
    enabled,
  });
  const values = [
    ...new Set([
      ...(fallback.data ? [fallback.data.category] : []),
      ...(categories.data?.categories.map((entry) => entry.category) ?? []),
    ]),
  ];
  return { values, fallback: fallback.data?.category };
}

export function InboxPage() {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const client = useQueryClient();
  const canWrite = session.permissions.includes("intake:write");
  const cats = useIntakeCategories();
  const st = useListState({ category: cats.fallback });
  const [state, setState] = useSearchParamState<StateFilter>("state", "all", isStateFilter);
  const [origin, setOrigin] = useSearchParamState<OriginFilter>("origin", "all", isOriginFilter);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [doomed, setDoomed] = useState<EntryView[]>([]);
  const menu = usePageMenu({ categories: "intake" });
  const { query, views } = useEntryViews();
  const items = sortRows(
    views.filter(
      (e) =>
        (st.cat === "all" || e.category === st.cat) &&
        (state === "all" || e.state === state) &&
        (origin === "all" || e.source === origin) &&
        matches(st.q, e.title, e.from, e.body),
    ),
    sortValueOf(ENTRY_SORT, st.sort.key),
    st.sort.order,
  );
  const other = t("catalog.categoryOther");
  const key =
    st.group === "category"
      ? (e: EntryView) => humanizeCategory(e.category, other)
      : st.group === "status"
        ? (e: EntryView) => t(STATUS_KEY[e.status])
        : st.group === "origin"
          ? (e: EntryView) => t(ORIGIN_KEY[e.origin])
          : null;
  const open = views.filter(isOpenEntry).length;
  const discarded = items.filter((e) => e.state === "discarded");
  const awaiting = awaitingAssistantReview(
    views.filter((e) => st.cat === "all" || e.category === st.cat),
  );
  const head: Head[] = [
    ...(canWrite && discarded.length ? [""] : []),
    { label: t("kn.inbox.col.source"), sort: "title" },
    { label: t("kn.inbox.col.from"), id: "from", priority: "low" },
    { label: t("kn.col.category"), sort: "category" },
    { label: t("kn.col.status"), id: "status" },
    { label: t("kn.inbox.col.created"), sort: "created", priority: "low" },
  ];
  const columns = useColumnChoice(head);
  const prompts = PROMPTS.map((k) => t(k));
  const chosen = discarded.filter((e) => selected.has(e.id));
  const setDefault = useMutation({
    mutationFn: (category: string) => setIntakeDefaultCategory(category),
    onSuccess: (_r, category) => {
      st.setCat(category);
      setChoosing(false);
      void client.invalidateQueries({ queryKey: ["intake"] });
    },
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
  const remove = useMutation({
    mutationFn: async (list: EntryView[]) => {
      let conflicts = 0;
      for (const e of list) {
        try {
          await deleteDiscardedIntakeClip(e.id, e.version);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) conflicts++;
          else throw error;
        }
      }
      return { conflicts, many: list.length > 1 };
    },
    onSuccess: ({ conflicts, many }) => {
      if (conflicts) toast.error(t("intake.deleteConflict"));
      else toast.success(t(many ? "intake.deleteSelectedSuccess" : "intake.deleteSuccess"));
      setSelected(new Set());
      setDoomed([]);
      void client.invalidateQueries({ queryKey: ["intake"] });
    },
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const stateOptions = (["all", ...INTAKE_STATES] as StateFilter[]).map((v) => ({
    value: v,
    label: t(v === "all" ? "kn.groups.all" : `intake.state.${v}`),
  }));
  const originOptions = (["all", ...INTAKE_ORIGINS] as OriginFilter[]).map((v) => ({
    value: v,
    label: t(v === "all" ? "kn.groups.all" : `intake.origin.${v}`),
  }));
  const reset = () => {
    st.reset();
    setState("all");
    setOrigin("all");
  };
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
      <TopPageHeader
        title={t("nav.inbox")}
        action={
          <div className="flex items-center gap-2">
            <ChatMenu
              label={t("kn.inbox.reviewInChat")}
              prompts={prompts}
              items={[
                ...menu.items,
                ...(canWrite
                  ? [
                      {
                        label: t("intake.chooseDefault"),
                        onSelect: () => setChoosing(true),
                        testId: "kn-inbox-default-category",
                      },
                    ]
                  : []),
              ]}
            />
            {canWrite && (
              <Button data-testid="kn-inbox-add" onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                {t("kn.inbox.add")}
              </Button>
            )}
          </div>
        }
      />
      <FlowStrip />
      {query.data && views.length === 0 && (
        <OnboardingCard
          icon={Inbox}
          title={t("kn.inbox.onboardTitle")}
          text={t("kn.inbox.onboardText")}
        >
          {canWrite && (
            <Button
              data-testid="kn-inbox-addNote"
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              <StickyNote className="size-4" aria-hidden />
              {t("kn.inbox.addNote")}
            </Button>
          )}
        </OnboardingCard>
      )}
      <Loaded query={query}>
        {() => (
          <>
            <Toolbar
              st={st}
              groups={["category", "status", "origin"]}
              categories={withCategory(categoryCounts(views), st.cat)}
              columns={columns}
              onReset={reset}
              filters={[
                {
                  label: t("kn.col.status"),
                  value: state,
                  defaultValue: "all",
                  onChange: (v) => setState(isStateFilter(v) ? v : "all"),
                  options: stateOptions,
                  testId: "kn-inbox-state",
                },
                {
                  label: t("kn.groups.origin"),
                  value: origin,
                  defaultValue: "all",
                  onChange: (v) => setOrigin(isOriginFilter(v) ? v : "all"),
                  options: originOptions,
                  testId: "kn-inbox-origin",
                },
              ]}
            />
            <ListSummary
              testId="kn-inbox-summary"
              parts={[
                plural(t, "kn.inbox.count", items.length, { open }),
                awaiting > 0 ? (
                  <Button
                    key="awaiting"
                    data-testid="intake-awaiting-review"
                    variant="link"
                    className="h-auto px-0 text-sm"
                    onClick={() => setOrigin("session")}
                  >
                    {t(
                      awaiting === 1 ? "intake.awaitingReview.one" : "intake.awaitingReview.other",
                      { count: awaiting },
                    )}
                  </Button>
                ) : null,
              ]}
            />
            {canWrite && chosen.length > 0 && (
              <section
                aria-label={t("kn.skills.cand.selection")}
                data-testid="kn-inbox-bulk"
                className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
              >
                <span className="mr-auto">{t("kn.skills.cand.chosen", { n: chosen.length })}</span>
                <Button
                  data-testid="kn-inbox-bulk-clear"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                >
                  {t("intake.clearDeletionSelection")}
                </Button>
                <Button
                  data-testid="kn-inbox-bulk-delete"
                  size="sm"
                  variant="outline"
                  className="text-destructive-ink"
                  disabled={remove.isPending}
                  onClick={() => setDoomed(chosen)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("intake.deleteSelected", { count: chosen.length })}
                </Button>
              </section>
            )}
            {items.length ? (
              <GroupedTable
                head={head}
                hidden={columns.hidden}
                sort={st.sort}
                onSort={st.sortBy}
                groups={groupBy(items, key)}
                row={(e) => {
                  const I = ORIGIN_ICON[e.origin];
                  return (
                    <Row
                      key={e.id}
                      onOpen={() => void navigate({ to: recordHref("intake", e.id) })}
                      label={e.title}
                    >
                      {canWrite && discarded.length > 0 && (
                        <td className="w-10">
                          {e.state === "discarded" && (
                            <Checkbox
                              data-testid="kn-inbox-select"
                              aria-label={t("intake.selectDiscarded", { title: e.title })}
                              checked={selected.has(e.id)}
                              onClick={(ev) => ev.stopPropagation()}
                              onCheckedChange={(v) => toggle(e.id, v === true)}
                            />
                          )}
                        </td>
                      )}
                      <td>
                        <NameCell
                          icon={
                            <IconTile
                              icon={e.attachment ? FILE_ICON[e.attachment.kind] : I}
                              size="sm"
                            />
                          }
                          title={e.title}
                          sub={
                            e.attachment
                              ? `${e.attachment.name} · ${formatBytes(e.attachment.size, locale)}`
                              : t(ORIGIN_KEY[e.origin])
                          }
                        />
                      </td>
                      <td className="text-muted-foreground">
                        <Measured measure="label">{e.from}</Measured>
                      </td>
                      <td>{humanizeCategory(e.category, other)}</td>
                      <td>
                        <StatusCell tone={ENTRY_TONE[e.status]} label={t(STATUS_KEY[e.status])} />
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">
                        {dateTime(e.created)}
                      </td>
                    </Row>
                  );
                }}
              />
            ) : views.length ? (
              <NoMatch onReset={reset} />
            ) : null}
          </>
        )}
      </Loaded>
      {canWrite && (
        <IntakeNoteDialog
          categories={cats.values}
          initialCategory={st.cat !== "all" ? st.cat : cats.fallback}
          open={adding}
          onOpenChange={setAdding}
          onCreated={(clip) => {
            setAdding(false);
            void navigate({ to: recordHref("intake", clip.id) });
          }}
        />
      )}
      {canWrite && (
        <IntakeDefaultCategoryDialog
          category={cats.fallback}
          initialCategory={st.cat !== "all" ? st.cat : undefined}
          categories={cats.values}
          open={choosing}
          onOpenChange={setChoosing}
          onSave={(category) => setDefault.mutate(category)}
        />
      )}
      <ConfirmDialog
        destructive
        testId="kn-inbox-delete-selected-confirm"
        open={doomed.length > 0}
        onOpenChange={(v) => !v && setDoomed([])}
        title={
          doomed.length > 1
            ? t("intake.deleteSelected", { count: doomed.length })
            : t("kn.deleteTitle", { name: doomed[0]?.title ?? "" })
        }
        consequence={t(
          doomed.length > 1 ? "intake.deleteSelectedConsequence" : "intake.deleteConsequence",
        )}
        confirmLabel={t("intake.delete")}
        onConfirm={() => remove.mutate(doomed)}
      />
      {menu.dialogs}
    </div>
  );
}

export function InboxEntryPage({ id }: { id: string }) {
  const item = useQuery({ queryKey: KEYS.entry(id), queryFn: () => getIntakeClip(id) });
  const proposals = useProposals();
  if (!item.data && !item.isError) return <ListSkeleton />;
  return (
    <Loaded query={item}>
      {(clip) => <EntryDetail key={clip.id} clip={clip} proposals={proposals.data?.items ?? []} />}
    </Loaded>
  );
}

type Clip = Awaited<ReturnType<typeof getIntakeClip>>;
type Proposal = NonNullable<ReturnType<typeof useProposals>["data"]>["items"][number];

const TABS = ["content", "review", "history"] as const;
const EVENT_KEY = {
  collected: "kn.inbox.event.collected",
  proposed: "kn.inbox.event.proposed",
  changed: "kn.inbox.event.changed",
  confirmed: "kn.inbox.event.confirmed",
  rejected: "kn.inbox.event.rejected",
  discarded: "kn.inbox.event.discarded",
} as const;
const EVENT_TONE = {
  collected: "info",
  proposed: "info",
  changed: "warning",
  confirmed: "success",
  rejected: "neutral",
  discarded: "neutral",
} as const;

function EntryDetail({ clip, proposals }: { clip: Clip; proposals: Proposal[] }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const router = useRouter();
  const session = useSession();
  const client = useQueryClient();
  const refresh = useRefreshKnowledge();
  const rel = useRel();
  const directory = useActorDirectory(true);
  const cats = useIntakeCategories();
  const e = entryView(clip, proposals);
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const params = new URLSearchParams(search);
  const related = proposals.filter((p) => p.revision.items.some((x) => x.id === clip.id));
  const openProposals = related.filter((p) => p.status !== "confirmed" && p.status !== "rejected");
  const [firstTab] = useState(() =>
    e.status === "review" || openProposals.length ? "review" : "content",
  );
  const tab = tabFromSearch(search, "tab", TABS, firstTab);
  const setTab = (next: string) =>
    router.history.replace(
      `${window.location.pathname}${searchWithTab(window.location.search, "tab", next, firstTab)}${window.location.hash}`,
    );
  const focus = params.get("proposal");
  const I = ORIGIN_ICON[e.origin];
  const canWrite = session.permissions.includes("intake:write");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const snapshot = sessionSnapshot(clip.original_snapshot);
  const conversationId = snapshot ? intakeConversationId(snapshot) : null;
  const conversation = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversation(conversationId ?? ""),
    enabled: session.permissions.includes("conversation:read") && !!conversationId,
    retry: false,
  });
  const write = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEYS.entry(clip.id) });
      void refresh();
    },
    onError: (error) => reportFailure(t(intakeWriteFailureKey(error)), error),
  });
  const edit = useMutation({
    mutationFn: (input: Parameters<typeof updateIntakeClip>[1]) => updateIntakeClip(clip.id, input),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: KEYS.entry(clip.id) });
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDiscardedIntakeClip(clip.id, clip.version),
    onSuccess: () => {
      toast.success(t("intake.deleteSuccess"));
      void refresh();
      void navigate({ to: "/intake" });
    },
    onError: (error) =>
      reportFailure(
        t(
          error instanceof ApiError && error.status === 409
            ? "intake.deleteConflict"
            : "common.actionFailed",
        ),
        error,
      ),
  });
  const setState = (state: "collected" | "discarded") =>
    write.mutate(() => setIntakeClipState(clip.id, { state, expected_version: clip.version }));
  const strip = entryStrip(e);
  const resultHref = e.result
    ? recordHref(e.result.kind === "skill" ? "skills" : "knowledge", e.result.id)
    : null;
  const stripText =
    strip.key === "accepted"
      ? t(
          e.result?.kind === "skill"
            ? "kn.inbox.strip.acceptedSkill"
            : "kn.inbox.strip.acceptedSource",
        )
      : strip.key === "rejected"
        ? t("kn.inbox.strip.rejected")
        : strip.key === "review"
          ? t("kn.inbox.strip.review")
          : t("kn.inbox.strip.collected", { when: rel(e.created) });
  const stripAction =
    strip.action === "openResult" && resultHref ? (
      <Button
        data-testid="kn-inbox-open-result"
        size="sm"
        variant="outline"
        onClick={() => void navigate({ to: resultHref })}
      >
        {t(e.result?.kind === "skill" ? "kn.inbox.openSkill" : "kn.inbox.openSource")}
      </Button>
    ) : clip.state === "discarded" && canWrite ? (
      <Button
        data-testid="kn-inbox-restore"
        size="sm"
        variant="outline"
        disabled={write.isPending}
        onClick={() => setState("collected")}
      >
        {t("intake.restore")}
      </Button>
    ) : strip.action === "review" ? (
      <Button
        data-testid="kn-inbox-strip-review"
        size="sm"
        variant="outline"
        onClick={() => setTab("review")}
      >
        {t("kn.tab.review")}
      </Button>
    ) : undefined;
  const references = [{ type: "intake_item" as const, id: clip.id }];
  const events = intakeEvents(clip, related);
  const collector = actorLabel(directory, clip.collected_by, t);
  const evidence = clip.evidence ?? [];
  const hiddenEvidence = (clip.evidence_total ?? 0) - evidence.length;
  const published = publishedDate(clip.original_snapshot.published_at, dateTime);
  const author = clip.original_snapshot.source_author;
  const review = openProposals.length ? (
    <div className="flex flex-col gap-4">
      {openProposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          permissions={session.permissions}
          focused={proposal.id === focus}
          onConfirm={() =>
            write.mutate(() =>
              confirmIntakeProposal(proposal.id, {
                expected_revision: proposal.revision.revision,
                digest: proposal.revision.digest,
              }),
            )
          }
          onReject={() =>
            write.mutate(() =>
              rejectIntakeProposal(proposal.id, { expected_revision: proposal.revision.revision }),
            )
          }
        />
      ))}
    </div>
  ) : (
    <Panel>
      <p className="text-sm text-muted-foreground">{t("kn.inbox.noSuggestion")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {session.permissions.includes("conversation:write") && (
          <ChatMenuButton
            label={t("kn.inbox.reviewInChat")}
            prompt={`${t("kn.inbox.prompt.review")}: ${e.title}`}
            references={references}
          />
        )}
        {canWrite && isOpenEntry(e) && (
          <Button
            data-testid="kn-inbox-discard"
            variant="ghost"
            disabled={write.isPending}
            onClick={() => setState("discarded")}
          >
            <XCircle className="size-4" aria-hidden />
            {t("kn.inbox.reject")}
          </Button>
        )}
      </div>
    </Panel>
  );

  return (
    <>
      <DetailShell
        back={t("kn.inbox.title")}
        onBack={() => void navigate({ to: "/intake" })}
        icon={<IconTile icon={I} size="lg" />}
        title={e.title}
        sub={[t(ORIGIN_KEY[e.origin]), e.from, collector].filter(Boolean).join(" · ")}
        strip={{
          tone: strip.tone,
          text: stripText,
          ...(stripAction ? { action: stripAction } : {}),
        }}
        tab={tab}
        onTab={setTab}
        menu={
          <ChatMenu
            label={t("kn.detailMenu")}
            references={references}
            prompts={[t("kn.inbox.prompt.review"), t("kn.inbox.prompt.summarize")]}
            items={
              canWrite
                ? [
                    {
                      label: t("intake.editItem"),
                      onSelect: () => setEditing(true),
                      testId: "kn-inbox-edit",
                    },
                    ...(clip.state !== "discarded" && clip.state !== "admitted"
                      ? [
                          {
                            label: t("intake.discard"),
                            onSelect: () => setState("discarded"),
                            disabled: write.isPending,
                            testId: "kn-inbox-menu-discard",
                          },
                        ]
                      : []),
                    ...(clip.state === "discarded"
                      ? [
                          {
                            label: t("intake.delete"),
                            onSelect: () => setDeleting(true),
                            destructive: true,
                            testId: "kn-inbox-delete",
                          },
                        ]
                      : []),
                  ]
                : []
            }
            extra={
              <>
                {e.url ? (
                  <DropdownMenuItem asChild>
                    <a
                      data-testid="kn-inbox-openOriginal"
                      href={e.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <ExternalLink className="size-4" aria-hidden />
                      {t("kn.inbox.openOriginal")}
                    </a>
                  </DropdownMenuItem>
                ) : null}
                {conversation.data ? (
                  <DropdownMenuItem
                    data-testid="kn-inbox-open-conversation"
                    onSelect={() =>
                      void navigate({ to: conversationHref(conversation.data.conversation.id) })
                    }
                  >
                    <MessageSquare className="size-4" aria-hidden />
                    {t("intake.openConversation")}
                  </DropdownMenuItem>
                ) : null}
              </>
            }
          />
        }
        tabs={[
          {
            id: "content",
            label: t("kn.tab.content"),
            content: (
              <div className="flex flex-col gap-4">
                {e.attachment && <AttachmentCard attachment={e.attachment} />}
                <MarkdownDocument text={e.body} underTitle={e.title} />
                {snapshot && (evidence.length > 0 || snapshot.evidence_excerpt.trim()) && (
                  <CollapsibleSection
                    label={t("intake.session.evidence")}
                    count={evidence.length || undefined}
                    testId="kn-inbox-evidence"
                  >
                    <div className="flex flex-col gap-3">
                      {evidence.length ? (
                        evidence.map((row) => (
                          <div key={row.id} className="rounded-lg border p-3">
                            <p className="mb-1 text-xs text-muted-foreground">
                              {[row.repo, dateTime(row.captured_at)].filter(Boolean).join(" · ")}
                            </p>
                            <MarkdownDocument text={row.excerpt} toolbar={false} toc={false} />
                          </div>
                        ))
                      ) : (
                        <MarkdownDocument
                          text={snapshot.evidence_excerpt}
                          toolbar={false}
                          toc={false}
                        />
                      )}
                      {hiddenEvidence > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {t("intake.session.evidenceMore", { count: hiddenEvidence })}
                        </p>
                      )}
                    </div>
                  </CollapsibleSection>
                )}
                {clip.body !== clip.original_snapshot.body && (
                  <CollapsibleSection label={t("intake.originalSource")} testId="kn-inbox-original">
                    <MarkdownDocument
                      text={clip.original_snapshot.body}
                      toolbar={false}
                      toc={false}
                    />
                  </CollapsibleSection>
                )}
              </div>
            ),
          },
          {
            id: "review",
            label: openProposals.length
              ? `${t("kn.tab.review")} · ${openProposals.length}`
              : t("kn.tab.review"),
            content: review,
          },
          {
            id: "history",
            label: t("kn.tab.history"),
            content: (
              <Timeline
                lang={locale}
                time={(iso) => dateTime(iso)}
                items={events.map((ev) => ({
                  id: ev.id,
                  at: ev.at,
                  tone: EVENT_TONE[ev.kind],
                  icon:
                    ev.kind === "confirmed"
                      ? CheckCircle2
                      : ev.kind === "rejected" || ev.kind === "discarded"
                        ? XCircle
                        : I,
                  content: (
                    <p className="text-sm">
                      {t(EVENT_KEY[ev.kind])}
                      {ev.title ? ` · ${ev.title}` : ""}
                    </p>
                  ),
                }))}
              />
            ),
          },
        ]}
        facts={[
          { label: t("kn.fact.ref"), value: `@intake:${clip.id.slice(0, 8)}`, mono: true },
          {
            label: t("kn.col.category"),
            value: humanizeCategory(clip.category, t("catalog.categoryOther")),
          },
          ...(author ? [{ label: t("kn.inbox.author"), value: author }] : []),
          ...(published ? [{ label: t("kn.inbox.published"), value: published }] : []),
          ...(snapshot?.agent ? [{ label: t("intake.session.agent"), value: snapshot.agent }] : []),
          ...(snapshot?.session_id
            ? [
                {
                  label: t("intake.session.id"),
                  value: sessionLabel(snapshot.session_id, t),
                  mono: true,
                },
              ]
            : []),
          ...(snapshot && sessionPlace(snapshot)
            ? [{ label: t("intake.session.place"), value: sessionPlace(snapshot) ?? "" }]
            : []),
          { label: t("kn.fact.version"), value: String(clip.version) },
          { label: t("kn.fact.created"), value: dateTime(clip.created_at) },
          ...(e.url ? [{ label: t("kn.fact.address"), value: e.url, mono: true }] : []),
          { label: t("kn.fact.id"), value: clip.id, mono: true },
        ]}
      />
      {canWrite && (
        <IntakeEditDialog
          clip={editing ? clip : null}
          categories={cats.values}
          open={editing}
          pending={edit.isPending}
          error={
            edit.error instanceof ApiError && edit.error.status === 409
              ? t("intake.editConflict")
              : edit.isError
                ? dialogFailure(t("common.actionFailed"), edit.error)
                : null
          }
          conflict={edit.error instanceof ApiError && edit.error.status === 409}
          onReload={() => {
            edit.reset();
            void client.invalidateQueries({ queryKey: KEYS.entry(clip.id) });
          }}
          onOpenChange={(v) => {
            setEditing(v);
            if (!v) edit.reset();
          }}
          onSave={(_c, input) => edit.mutate(input)}
        />
      )}
      <ConfirmDialog
        destructive
        testId="kn-inbox-delete-confirm"
        open={deleting}
        onOpenChange={setDeleting}
        title={t("kn.deleteTitle", { name: clip.title })}
        consequence={t("intake.deleteConsequence")}
        confirmLabel={t("intake.delete")}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function ChatMenuButton({
  label,
  prompt,
  references,
}: {
  label: string;
  prompt: string;
  references: { type: "intake_item"; id: string }[];
}) {
  const navigate = useNavigate();
  return (
    <Button
      data-testid="kn-inbox-review-in-chat"
      variant="outline"
      onClick={() => void navigate(routerTarget(chatNewHref({ prompt, references })))}
    >
      <Sparkles className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

function AttachmentCard({ attachment: a }: { attachment: EntryAttachment }) {
  const { t, locale } = useI18n();
  const href = tenantContentHref(`/v1/files/${encodeURIComponent(a.fileId)}/content`);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <IconTile icon={FILE_ICON[a.kind]} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{a.name}</p>
          <p className="text-xs text-muted-foreground">
            {t("kn.inbox.attachment")} · {formatBytes(a.size, locale)}
          </p>
        </div>
        {a.ready && (
          <Button asChild size="sm" variant="outline">
            <a
              data-testid="kn-inbox-open-file"
              href={href}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink className="size-4" aria-hidden />
              {t("kn.inbox.openFile")}
            </a>
          </Button>
        )}
      </div>
      {a.ready && a.kind === "image" && (
        <img src={href} alt={a.name} className="w-full rounded-lg border bg-background" />
      )}
    </div>
  );
}
