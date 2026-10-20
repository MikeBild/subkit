import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { listProposedSkillCandidates, type SkillCandidate } from "@/api/decisions";
import type { components } from "@/api/schema";
import { useActorDirectory } from "@/app/actor-directory";
import { type ActorDirectory, actorLabel } from "@/app/actor-directory-model";
import { absolute, chatNewHref, recordHref, routerTarget } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useDirtyGuard } from "@/app/version-notice";
import { CatalogOriginSummary, useCatalogOrigin } from "@/components/cockpit/catalog-categories";
import {
  CatalogMetadataDialog,
  CatalogMetadataSummary,
  CatalogNameCell,
  useCatalogMetadataActions,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import { ORIGIN_LABEL } from "@/components/cockpit/decision-card";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DataTable,
  type Fact,
  FactList,
  Field,
  FieldError,
  FieldLabel,
  FilePreview,
  FilterBar,
  GroupingTabs,
  Input,
  Page,
  PageHeader,
  SaveBar,
  Section,
  SegmentedControl,
  StatusBadge,
  StatusStrip,
  SummaryLine,
  Textarea,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState, queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { skillDecision } from "@/pages/decisions-model";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";
import { isDetectedPattern } from "@/pages/skill-proposal-model";
import { SkillProposalRowActions } from "@/pages/skill-proposal-row-actions";
import { SkillProposalSheet } from "@/pages/skill-proposal-sheet";
import {
  SKILL_APPLIES_TO,
  type SkillAppliesTo,
  skillAppliesToOptionKey,
  skillScopeKey,
  skillStateLabelKey,
  skillsLoadState,
  skillWhereKey,
} from "@/pages/skills-model";

type Skill = components["schemas"]["Skill"];
type Translate = ReturnType<typeof useI18n>["t"];

const ENDPOINT = "/v1/skills";
const PROPOSALS_KEY = ["skill-candidates", "proposed"];

function skillsLine(t: Translate, skills: number, proposals: number): string {
  const count = t(skills === 1 ? "skills.summary.one" : "skills.summary.other", { count: skills });
  if (proposals === 0) return count;
  return `${count} · ${t(proposals === 1 ? "skills.proposals.one" : "skills.proposals.other", { count: proposals })}`;
}

function StateBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return (
    <StatusBadge
      state={status === "archived" ? "disabled" : status}
      label={t(skillStateLabelKey(status))}
    />
  );
}

type SkillRow = { kind: "skill"; skill: Skill } | { kind: "proposal"; candidate: SkillCandidate };

function rowTitle(row: SkillRow): string {
  return row.kind === "skill" ? row.skill.title : row.candidate.title;
}

function rowAddress(row: SkillRow): string | null {
  return row.kind === "skill" ? recordHref("skills", row.skill.id) : null;
}

function rowScope(row: SkillRow): string {
  return row.kind === "skill" ? row.skill.scope : row.candidate.scope;
}

function rowWhere(row: SkillRow): string | null {
  return row.kind === "skill" ? row.skill.applies_to : null;
}

function proposalLine(candidate: SkillCandidate, directory: ActorDirectory, t: Translate): string {
  const reason = t(ORIGIN_LABEL[skillDecision(candidate).origin]);
  const author = actorLabel(directory, candidate.proposed_by, t);
  return author ? `${reason} · ${t("proposal.by", { name: author })}` : reason;
}

export function SkillsPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const canRead = permissions.includes("skill:read");
  const canWrite = permissions.includes("skill:write");
  const canChat = permissions.includes("conversation:write");
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupMode, setGroupMode] = useState("all");
  const q = useDebouncedValue(search).trim();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [first] = sorting;
  const categoryFilter = useCategoryFilter("skill");
  const origin = useCatalogOrigin();
  const list = useInfiniteList<Skill>(
    ENDPOINT,
    {
      q: q || undefined,
      category: categoryFilter.category,
      description_source: origin.descriptionSource,
      sort: first?.id ?? "updated_at",
      order: first?.desc ? "desc" : "asc",
    },
    { enabled: canRead },
  );
  const proposals = useQuery({
    queryKey: PROPOSALS_KEY,
    queryFn: () => listProposedSkillCandidates(),
    enabled: canRead,
    ...live,
  });
  const open = (proposals.data?.items ?? []).filter(isDetectedPattern);
  const proposal = open.find((candidate) => candidate.id === proposalId) ?? null;
  const directory = useActorDirectory(canRead && open.length > 0);
  const decided = () => {
    void client.invalidateQueries({ queryKey: PROPOSALS_KEY });
    void client.invalidateQueries({ queryKey: ["catalog"] });
    void client.invalidateQueries({ queryKey: ["decisions"] });
    void client.invalidateQueries({ queryKey: ["attention"] });
  };
  const title = t("nav.skills");

  const columns = useMemo<CockpitColumn<SkillRow>[]>(() => {
    const column = tableColumns<SkillRow>({ t, dateTime });
    return [
      column.custom(
        "title",
        (row) => rowTitle(row),
        t("skills.column.name"),
        (row) =>
          row.kind === "skill" ? (
            <CatalogNameCell name={row.skill.title} record={row.skill} />
          ) : (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{rowTitle(row)}</span>
              <span
                className="truncate text-xs text-muted-foreground"
                data-testid={`skill-proposal-row-target-${row.candidate.id}`}
              >
                {proposalLine(row.candidate, directory, t)}
              </span>
            </span>
          ),
        {
          sortable: true,
          width: "w-[36%]",
        },
      ),
      column.custom(
        "status",
        (row) => (row.kind === "skill" ? row.skill.status : "proposed"),
        t("resource.field.status"),
        (row) =>
          row.kind === "skill" ? (
            <StateBadge status={row.skill.status} />
          ) : (
            <StatusBadge state="proposed" label={t("skills.state.proposed")} />
          ),
        { sortable: true, width: "w-[14%]" },
      ),
      {
        ...column.custom(
          "scope",
          (row) => rowScope(row),
          t("skills.column.scope"),
          (row) => t(skillScopeKey(rowScope(row))),
          { sortable: true, width: "w-[14%]" },
        ),
        meta: { width: "w-[14%]", priority: "low" },
      },
      {
        ...column.custom(
          "applies_to",
          (row) => rowWhere(row) ?? "",
          t("skills.column.where"),
          (row) => {
            const where = rowWhere(row);
            return where ? t(skillWhereKey(where)) : MISSING;
          },
          { width: "w-[18%]" },
        ),
        meta: { width: "w-[18%]", priority: "low" },
      },
      column.date(
        "updated_at",
        (row) => (row.kind === "skill" ? row.skill.updated_at : row.candidate.updated_at),
        t("skills.column.changed"),
        { sortable: true, width: "w-[18%]" },
      ),
    ];
  }, [t, dateTime, directory]);

  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="catalog-skills"
        header={<PageHeader eyebrow={t("nav.group.knowledge")} title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const rows: SkillRow[] = [
    ...(q || categoryFilter.category || origin.active
      ? []
      : open.map((candidate) => ({ kind: "proposal" as const, candidate }))),
    ...list.items.map((skill) => ({ kind: "skill" as const, skill })),
  ];
  const { pending, failed } = skillsLoadState([list.query, proposals]);
  const empty =
    !pending && !failed && rows.length === 0 && !q && !categoryFilter.category && !origin.active;
  const newButton = (testId: string) =>
    canWrite ? (
      <Button asChild>
        <a href={absolute(recordHref("skills", "new"))} data-testid={testId}>
          {t("skills.new")}
        </a>
      </Button>
    ) : undefined;

  return (
    <Page
      kind="list"
      surface="collection"
      scroll="page"
      testId="catalog-skills"
      header={
        <PageHeader
          eyebrow={t("nav.group.knowledge")}
          title={title}
          action={empty ? undefined : newButton("skills-new")}
          secondary={
            canChat ? (
              <Button asChild variant="outline">
                <a
                  href={absolute(chatNewHref({ prompt: t("skills.draftPrompt") }))}
                  data-testid="skills-draft-in-chat"
                >
                  {t("skills.draftInChat")}
                </a>
              </Button>
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          {rows.length > 0 || origin.active || q || categoryFilter.category ? (
            <CatalogOriginSummary
              text={skillsLine(
                t,
                list.total ?? list.items.length,
                q || categoryFilter.category || origin.active ? 0 : open.length,
              )}
              help={t("skills.summaryHelp")}
              testId="skills-summary"
              kind="skill"
              origin={origin}
            />
          ) : null}
          <DataTable
            columns={columns}
            data={rows}
            groupingTabs={
              <GroupingTabs
                label={t("common.groupBy")}
                value={groupMode}
                onChange={setGroupMode}
                options={[
                  { value: "all", label: t("common.all") },
                  { value: "status", label: t("resource.field.status") },
                  { value: "scope", label: t("skills.column.scope") },
                ]}
                testId="skills-grouping"
                note={groupMode === "all" ? undefined : t("common.loadedOnly")}
              />
            }
            grouping={
              groupMode === "all"
                ? undefined
                : {
                    getKey: (row) =>
                      groupMode === "scope"
                        ? t(skillScopeKey(rowScope(row)))
                        : row.kind === "skill"
                          ? t(skillStateLabelKey(row.skill.status))
                          : t("skills.state.proposed"),
                  }
            }
            infinite={list.infinite}
            total={list.total}
            getRowId={(row) =>
              row.kind === "skill" ? row.skill.id : `proposal:${row.candidate.id}`
            }
            toolbar={
              <FilterBar
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: t("skills.search"),
                  testId: "skills-search",
                }}
                selects={categoryFilter.select ? [categoryFilter.select] : []}
                reset={{
                  label: t("catalog.clearFilters"),
                  onClick: () => {
                    setSearch("");
                    categoryFilter.select?.onChange("all");
                    origin.setValue("all");
                  },
                }}
              />
            }
            pending={pending}
            error={
              failed
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => {
                      void list.query.refetch();
                      void proposals.refetch();
                    },
                  }
                : null
            }
            emptyState={{
              zero: { title: t("skills.empty"), action: newButton("skills-empty-new") },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: () => {
                  setSearch("");
                  categoryFilter.select?.onChange("all");
                  origin.setValue("all");
                },
              },
            }}
            hasActiveFilters={Boolean(q || categoryFilter.category || origin.active)}
            sorting={sorting}
            onSortingChange={setSorting}
            onOpen={(row) => {
              if (row.kind === "proposal") setProposalId(row.candidate.id);
              else void navigate(routerTarget(recordHref("skills", row.skill.id)));
            }}
            rowHref={rowAddress}
            rowLabel={(row) =>
              row.kind === "proposal"
                ? t("skills.openProposal", { name: rowTitle(row) })
                : rowTitle(row)
            }
            columnsLabel={t("catalog.columns")}
            actionsLabel={t("common.actions")}
            rowActions={(row) =>
              row.kind === "proposal" ? (
                <SkillProposalRowActions
                  candidate={row.candidate}
                  permissions={permissions}
                  onDecided={decided}
                />
              ) : null
            }
            collectionId="skills"
          />
        </div>
      </div>
      <SkillProposalSheet
        candidate={proposal}
        permissions={permissions}
        onClose={() => setProposalId(null)}
        onDecided={decided}
      />
    </Page>
  );
}

export function SkillPage({ permissions }: { permissions: readonly string[] }): ReactNode {
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const searchStr: string = useRouterState({ select: (state) => state.location.searchStr });
  const editing = id === "new" || new URLSearchParams(searchStr).get("mode") === "edit";
  return editing ? (
    <SkillEditor id={id} permissions={permissions} />
  ) : (
    <SkillRecord id={id} permissions={permissions} />
  );
}

function useSkill(id: string, enabled: boolean) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["skill", id],
    queryFn: () => apiRequest<Skill>(`${ENDPOINT}/${encodeURIComponent(id)}`),
    enabled: enabled && Boolean(id) && id !== "new",
    ...live,
  });
}

function editHref(id: string): string {
  return `${absolute(recordHref("skills", id))}?mode=edit`;
}

function SkillRecord({ id, permissions }: { id: string; permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const canRead = permissions.includes("skill:read");
  const canWrite = permissions.includes("skill:write");
  const canActivate = permissions.includes("skill:activate");
  const canArchive = permissions.includes("skill:archive");
  const canDelete = permissions.includes("skill:delete");
  const canChat = permissions.includes("conversation:write");
  const query = useSkill(id, canRead);
  const [deleting, setDeleting] = useState(false);
  const [describing, setDescribing] = useState(false);
  const metadataActions = useCatalogMetadataActions({
    kind: "skill",
    id,
    record: query.data,
    queryKey: ["skill", id],
    onEdit: () => setDescribing(true),
  });
  const lifecycle = useOptimisticAction<"activate" | "archive", Skill, Skill>({
    queryKey: ["skill", id],
    mutationFn: (verb) =>
      apiRequest(`${ENDPOINT}/${encodeURIComponent(id)}/${verb}`, { method: "POST" }),
    apply: (current, verb) =>
      current ? { ...current, status: verb === "activate" ? "active" : "archived" } : current,
    invalidate: [["catalog"]],
    onSuccess: (skill, verb) =>
      toast.success(
        t(verb === "activate" ? "skills.activated" : "skills.deactivated", { name: skill.title }),
      ),
  });
  const remove = useMutation({
    mutationFn: () => apiRequest(`${ENDPOINT}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("skills.deleted", { name: query.data?.title ?? "" }));
      void client.invalidateQueries({ queryKey: ["catalog"] });
      void navigate({ to: "/skills" });
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

  const back = { to: "/skills", label: t("nav.skills") };
  const frame = (body: ReactNode) => (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId="detail-skills"
      header={<PageHeader back={back} title={MISSING} />}
    >
      {body}
    </Page>
  );
  if (!canRead) return frame(<ForbiddenState />);
  const view = queryView(query, () => false);
  if (view === "loading") return frame(<DataState state="loading" />);
  const skill = query.data;
  if (view === "error" || !skill)
    return frame(
      <DataState
        state="error"
        line={t("detail.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="detail-load-failed"
      />,
    );

  const active = skill.status === "active";
  const strip = active ? (
    <StatusStrip tone="ok" line={t("skills.strip.active")} testId="skill-strip" />
  ) : (
    <StatusStrip
      tone="warn"
      line={t(skill.status === "draft" ? "skills.strip.draft" : "skills.strip.disabled")}
      action={
        canActivate ? (
          <Button
            variant="outline"
            onClick={() => lifecycle.mutate("activate")}
            data-testid="skill-activate"
          >
            {t("skills.activate")}
          </Button>
        ) : undefined
      }
      testId="skill-strip"
    />
  );
  const technical: Fact[] = [
    ...(skill.slug
      ? [
          {
            label: t("skills.fact.slug"),
            value: <span className="font-mono text-xs">{skill.slug}</span>,
          },
        ]
      : []),
    { label: t("skills.fact.version"), value: String(skill.version) },
    { label: t("skills.fact.created"), value: dateTime(skill.created_at) },
  ];
  const menu = [
    ...(canWrite ? metadataActions : []),
    ...(active && canArchive
      ? [
          {
            label: t("skills.deactivate"),
            onSelect: () => lifecycle.mutate("archive"),
            testId: "skill-deactivate",
          },
        ]
      : []),
    ...(!active && canActivate
      ? [
          {
            label: t("skills.activate"),
            onSelect: () => lifecycle.mutate("activate"),
            testId: "skill-menu-activate",
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            label: t("skills.delete"),
            onSelect: () => setDeleting(true),
            destructive: true,
            testId: "skill-delete",
          },
        ]
      : []),
  ];

  return (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId="detail-skills"
      header={
        <PageHeader
          back={back}
          title={skill.title}
          purpose={<CatalogMetadataSummary record={skill} />}
          action={
            canWrite ? (
              <Button asChild>
                <a href={editHref(skill.id)} data-testid="skill-edit">
                  {t("skills.edit")}
                </a>
              </Button>
            ) : undefined
          }
          secondary={
            canChat ? (
              <Button asChild variant="outline">
                <a
                  href={absolute(
                    chatNewHref({
                      prompt: t("detail.changeRecordPrompt"),
                      references: [{ type: "skill", id: skill.id }],
                    }),
                  )}
                  data-testid="detail-action"
                >
                  {t("detail.changeInChat")}
                </a>
              </Button>
            ) : undefined
          }
          menu={menu.length > 0 ? <ActionMenu items={menu} testId="detail-menu" /> : undefined}
        />
      }
    >
      <div className="flex flex-col gap-8">
        {strip}
        <Section testId="skill-content">
          <SummaryLine
            text={t("skills.appliesTo", {
              scope: t(skillScopeKey(skill.scope)),
              where: t(skillWhereKey(skill.applies_to)),
              when: dateTime(skill.updated_at),
            })}
          />
          <FilePreview
            name=""
            mimeType="text/markdown"
            text={documentUnderTitle(skill.body, skill.title)}
            testId="skill-preview"
          />
        </Section>
        <CollapsibleSection label={t("knowledge.technical")} testId="detail-overview">
          <FactList items={technical} />
        </CollapsibleSection>
      </div>
      {canWrite ? (
        <CatalogMetadataDialog
          kind="skill"
          id={skill.id}
          record={skill}
          open={describing}
          onOpenChange={setDescribing}
          queryKey={["skill", skill.id]}
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        object={skill.title}
        verb={t("skills.delete")}
        consequence={t("skills.deleteConsequence")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutateAsync().then(() => undefined)}
        testId="skill-delete-confirm"
      />
    </Page>
  );
}

function SkillEditor({ id, permissions }: { id: string; permissions: readonly string[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const isNew = id === "new";
  const canWrite = permissions.includes("skill:write");
  const query = useSkill(id, permissions.includes("skill:read"));
  const skill = query.data;
  const original = {
    title: skill?.title ?? "",
    body: skill?.body ?? "",
    appliesTo: (skill?.applies_to ?? "both") as SkillAppliesTo,
  };
  const [title, setTitle] = useState(original.title);
  const [body, setBody] = useState(original.body);
  const [appliesTo, setAppliesTo] = useState<SkillAppliesTo>(original.appliesTo);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setTitle(skill?.title ?? "");
    setBody(skill?.body ?? "");
    setAppliesTo((skill?.applies_to ?? "both") as SkillAppliesTo);
  }, [skill?.title, skill?.body, skill?.applies_to]);
  const changes =
    (title !== original.title ? 1 : 0) +
    (body !== original.body ? 1 : 0) +
    (appliesTo !== original.appliesTo ? 1 : 0);
  const dirty = changes > 0;
  useDirtyGuard(dirty);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? apiRequest<Skill>(ENDPOINT, {
            method: "POST",
            body: JSON.stringify({
              scope: "global",
              title: title.trim(),
              body,
              applies_to: appliesTo,
              status: "active",
              source: "manual",
            }),
          })
        : apiRequest<Skill>(`${ENDPOINT}/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              title: title.trim(),
              body,
              applies_to: appliesTo,
              expected_version: skill?.version,
            }),
          }),
    onSuccess: (saved) => {
      toast.success(t("skills.saved"));
      client.setQueryData(["skill", saved.id], saved);
      void client.invalidateQueries({ queryKey: ["catalog"] });
      router.history.push(absolute(recordHref("skills", saved.id)));
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t("skills.conflict")
          : t("detail.saveFailed"),
      ),
  });
  const submit = () => {
    setProblem(null);
    if (!title.trim()) {
      setView("edit");
      return setProblem(t("skills.nameMissing"));
    }
    if (!body.trim()) {
      setView("edit");
      return setProblem(t("skills.bodyMissing"));
    }
    save.mutate();
  };

  const back = isNew
    ? { to: "/skills", label: t("nav.skills") }
    : { to: recordHref("skills", id), label: skill?.title ?? t("nav.skills") };
  const header = (
    <PageHeader back={back} title={isNew ? t("skills.newTitle") : t("skills.editTitle")} />
  );
  if (!canWrite)
    return (
      <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
        <ForbiddenState />
      </Page>
    );
  if (!isNew && query.isPending)
    return (
      <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
        <DataState state="loading" />
      </Page>
    );

  return (
    <Page kind="detail" surface="detail" scroll="page" testId="skill-editor" header={header}>
      <div className="flex flex-col gap-4">
        <SummaryLine
          text={t("skills.editor.summary")}
          aside={
            <SegmentedControl
              label={t("skills.editor.view")}
              value={view}
              onValueChange={(next) => setView(next as "edit" | "preview")}
              options={[
                { value: "edit", label: t("skills.editor.edit"), testId: "skill-editor-edit" },
                {
                  value: "preview",
                  label: t("skills.editor.preview"),
                  testId: "skill-editor-preview",
                },
              ]}
              testId="skill-editor-view"
            />
          }
        />
        {view === "edit" ? (
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="skill-name">{t("common.name")}</FieldLabel>
              <Input
                id="skill-name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("skills.editor.namePlaceholder")}
                data-testid="skill-name"
              />
            </Field>
            <Field>
              <FieldLabel>{t("skills.editor.appliesTo")}</FieldLabel>
              <SegmentedControl
                label={t("skills.editor.appliesTo")}
                value={appliesTo}
                onValueChange={(next) => setAppliesTo(next as SkillAppliesTo)}
                options={SKILL_APPLIES_TO.map((value) => ({
                  value,
                  label: t(skillAppliesToOptionKey(value)),
                  testId: `skill-applies-to-${value}`,
                }))}
                testId="skill-applies-to"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-body">{t("skills.editor.body")}</FieldLabel>
              <Textarea
                id="skill-body"
                rows={16}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={t("skills.editor.bodyPlaceholder")}
                className="font-mono text-xs"
                data-testid="skill-body"
              />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <FactList
              items={[
                { label: t("common.name"), value: title.trim() || MISSING },
                {
                  label: t("skills.column.scope"),
                  value: t(skillScopeKey(skill?.scope ?? "global")),
                },
              ]}
              testId="skill-editor-preview-facts"
            />
            <FilePreview
              name=""
              mimeType="text/markdown"
              text={documentUnderTitle(body, title)}
              testId="skill-editor-preview-body"
            />
          </div>
        )}
        {problem && !dirty ? (
          <FieldError data-testid="skill-editor-error">{problem}</FieldError>
        ) : null}
      </div>
      {dirty ? (
        <SaveBar
          count={changes}
          notice={problem ?? undefined}
          discard={{
            onClick: () => {
              setTitle(original.title);
              setBody(original.body);
              setAppliesTo(original.appliesTo);
              setProblem(null);
            },
            testId: "skill-discard",
          }}
          save={{ onClick: submit, pending: save.isPending, testId: "skill-save" }}
          testId="skill-save-bar"
        />
      ) : null}
    </Page>
  );
}
