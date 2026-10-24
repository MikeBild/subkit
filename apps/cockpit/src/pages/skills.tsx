import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import {
  Building2,
  Cable,
  ClipboardList,
  Inbox,
  LifeBuoy,
  type LucideIcon,
  MessageSquare,
  PenLine,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { listProposedSkillCandidates } from "@/api/decisions";
import { listIntakeClips } from "@/api/intake";
import type { components } from "@/api/schema";
import { useActorDirectory } from "@/app/actor-directory";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import {
  absolute,
  chatNewHref,
  connectorHref,
  recordHref,
  skillCandidatesHref,
  workflowHref,
} from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useDirtyGuard } from "@/app/version-notice";
import { CatalogSummary, useCatalogCreatedBy } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChips,
  catalogCategoryGrouping,
  categoryCounts,
} from "@/components/cockpit/catalog-grouping";
import {
  CatalogCategoryChip,
  CatalogMetadataDialog,
  CatalogNameCell,
  CatalogPurpose,
  useCatalogMetadataActions,
  useCategoryFilter,
} from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { VersionChange } from "@/components/cockpit/diff-card";
import { type UsageCard, UsageCards } from "@/components/cockpit/knowledge-usage";
import { RestoreVersionConfirm } from "@/components/cockpit/knowledge-versions";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  chipClass,
  DataState,
  DataTable,
  DetailPage,
  type Fact,
  FactList,
  Field,
  FieldError,
  FieldLabel,
  FilterBar,
  GroupingTabs,
  IconTile,
  Input,
  MarkdownDocument,
  MarkdownEditor,
  OnboardingFrame,
  Page,
  PageHeader,
  RecordSheet,
  SaveBar,
  SectionHeading,
  SegmentedControl,
  StatusBadge,
  TabBody,
  TemplateCard,
  TemplateGrid,
  Timeline,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";
import { keptVersionCount } from "@/pages/knowledge-versions-model";
import {
  SKILL_APPLIES_TO,
  SKILL_TEMPLATES,
  type SkillAppliesTo,
  type SkillHistoryDetail,
  type SkillHistoryEntry,
  type SkillTemplate,
  type SkillVersionRow,
  skillAppliesToOptionKey,
  skillChangedAt,
  skillHistoryGap,
  skillScope,
  skillScopeKey,
  skillScopePhraseKey,
  skillStateLabelKey,
  skillsListView,
  skillsLoadState,
  skillTemplateFromSearch,
  skillTemplateKeys,
  skillTemplates,
  skillVersionBasis,
  skillVersionChange,
  skillVersionRows,
  skillWhereKey,
} from "@/pages/skills-model";

type Skill = components["schemas"]["Skill"];
type Translate = ReturnType<typeof useI18n>["t"];

const ENDPOINT = "/v1/skills";
const PROPOSALS_KEY = ["skill-candidates", "proposed"];

const TEMPLATE_ICONS: Record<SkillTemplate, LucideIcon> = {
  tone: PenLine,
  report: ClipboardList,
  errors: LifeBuoy,
  company: Building2,
};

export function skillsLine(t: Translate, skills: number, proposals: number): ReactNode {
  const count = t(skills === 1 ? "skills.summary.one" : "skills.summary.other", { count: skills });
  if (proposals === 0) return count;
  return (
    <>
      {count} ·{" "}
      <a
        href={absolute(skillCandidatesHref())}
        className="underline underline-offset-2"
        data-testid="skills-review-candidates"
      >
        {t(proposals === 1 ? "skills.proposals.one" : "skills.proposals.other", {
          count: proposals,
        })}
      </a>
    </>
  );
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

function newSkillHref(template?: SkillTemplate): string {
  const href = recordHref("skills", "new");
  return template ? `${href}?template=${template}` : href;
}

function SkillsOnboarding({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const open = (href: string) => router.history.push(absolute(href));
  return (
    <OnboardingFrame lead={t("skills.onboarding.lead")} testId="skills-onboarding">
      <section className="flex flex-col gap-2" aria-labelledby="skills-onboarding-templates">
        <SectionHeading id="skills-onboarding-templates">
          {t("skills.onboarding.templates")}
        </SectionHeading>
        <TemplateGrid>
          {SKILL_TEMPLATES.map((template) => {
            const keys = skillTemplateKeys(template);
            const Icon = TEMPLATE_ICONS[template];
            const href = newSkillHref(template);
            return (
              <TemplateCard
                key={template}
                title={t(keys.title)}
                line={t(keys.line)}
                lead={
                  <IconTile>
                    <Icon />
                  </IconTile>
                }
                href={canWrite ? href : undefined}
                onSelect={canWrite ? () => open(href) : undefined}
                testId={`skills-template-${template}`}
              />
            );
          })}
        </TemplateGrid>
      </section>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
        <span className="flex-1 text-muted-foreground">{t("skills.onboarding.tip")}</span>
        {canWrite ? (
          <Button variant="outline" size="sm" asChild>
            <a href={absolute(newSkillHref())} data-testid="skills-onboarding-blank">
              {t("skills.onboarding.blank")}
            </a>
          </Button>
        ) : null}
      </div>
    </OnboardingFrame>
  );
}

export function SkillsPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const live = useLiveQueryOptions();
  const canRead = permissions.includes("skill:read");
  const canWrite = permissions.includes("skill:write");
  const canChat = permissions.includes("conversation:write");
  const [search, setSearch] = useSearchParamState("q", "");
  const [groupMode, setGroupMode] = useSearchParamState("group", "category");
  const q = useDebouncedValue(search).trim();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [first] = sorting;
  const categoryFilter = useCategoryFilter("skill");
  const origin = useCatalogCreatedBy();
  const list = useInfiniteList<Skill>(
    ENDPOINT,
    {
      q: q || undefined,
      category: categoryFilter.category,
      description_source: origin.descriptionSource,
      sort: first?.id ?? "updated_at",
      order: first?.desc ? "desc" : "asc",
      group_by: groupMode === "category" ? "category" : undefined,
    },
    { enabled: canRead },
  );
  const proposals = useQuery({
    queryKey: PROPOSALS_KEY,
    queryFn: () => listProposedSkillCandidates(),
    enabled: canRead,
    ...live,
  });
  const title = t("nav.skills");

  const columns = useMemo<CockpitColumn<Skill>[]>(() => {
    const column = tableColumns<Skill>({ t, dateTime });
    return [
      column.custom(
        "title",
        (skill) => skill.title,
        t("skills.column.name"),
        (skill) => (
          <CatalogNameCell
            name={skill.title}
            record={skill}
            hideCategory={groupMode === "category"}
          />
        ),
        {
          sortable: true,
          width: "w-[36%]",
        },
      ),
      column.custom(
        "status",
        (skill) => skill.status,
        t("resource.field.status"),
        (skill) => <StateBadge status={skill.status} />,
        { sortable: true, width: "w-[14%]" },
      ),
      {
        ...column.custom(
          "scope",
          (skill) => skillScope(skill),
          t("skills.column.scope"),
          (skill) => t(skillScopeKey(skillScope(skill))),
          { sortable: true, width: "w-[14%]" },
        ),
        meta: { width: "w-[14%]", priority: "low" },
      },
      {
        ...column.custom(
          "applies_to",
          (skill) => skill.applies_to ?? "",
          t("skills.column.where"),
          (skill) => (skill.applies_to ? t(skillWhereKey(skill.applies_to)) : MISSING),
          { width: "w-[18%]" },
        ),
        meta: { width: "w-[18%]", priority: "low" },
      },
      column.date("updated_at", (skill) => skill.updated_at, t("skills.column.changed"), {
        sortable: true,
        width: "w-[18%]",
      }),
    ];
  }, [t, dateTime, groupMode]);

  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="catalog-skills"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const { pending, failed } = skillsLoadState([list.query, proposals]);
  const filtered = Boolean(q || categoryFilter.category || origin.active);
  const view = skillsListView({
    skills: list.items,
    candidates: proposals.data?.items ?? [],
    filtered,
    settled: !pending && !failed,
  });
  const empty = view.onboarding;
  const newButton = (testId: string) =>
    canWrite ? (
      <Button asChild>
        <a href={absolute(newSkillHref())} data-testid={testId}>
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
          title={title}
          action={empty ? undefined : newButton("skills-new")}
          menu={
            canChat ? (
              <ActionMenu
                alwaysMenu
                testId="skills-page-actions"
                items={[
                  {
                    label: t("skills.draftInChat"),
                    href: absolute(chatNewHref({ prompt: t("skills.draftPrompt") })),
                    testId: "skills-draft-in-chat",
                  },
                ]}
              />
            ) : undefined
          }
        />
      }
    >
      {empty ? (
        <SkillsOnboarding canWrite={canWrite} />
      ) : (
        <div className="flex flex-col gap-3">
          {view.summary ? (
            <CatalogSummary
              text={skillsLine(t, list.total ?? list.items.length, view.proposals)}
              help={t("skills.summaryHelp")}
              testId="skills-summary"
              kind="skill"
            />
          ) : null}
          <DataTable
            columns={columns}
            data={view.rows}
            groupingTabs={
              <>
                <GroupingTabs
                  label={t("common.groupBy")}
                  value={groupMode}
                  onChange={setGroupMode}
                  options={[
                    { value: "all", label: t("common.all") },
                    { value: "category", label: t("resource.field.category") },
                    { value: "status", label: t("resource.field.status") },
                    { value: "scope", label: t("skills.column.scope") },
                  ]}
                  testId="skills-grouping"
                  note={
                    groupMode === "all" || groupMode === "category"
                      ? undefined
                      : t("common.loadedOnly")
                  }
                />
                <CatalogCategoryChips
                  usage={categoryFilter.usage}
                  value={categoryFilter.value}
                  onChange={categoryFilter.setValue}
                />
              </>
            }
            grouping={
              groupMode === "all"
                ? undefined
                : groupMode === "category"
                  ? catalogCategoryGrouping<Skill>({
                      getCategory: (skill) => recordCategory(skill),
                      otherLabel: t("catalog.categoryOther"),
                      ...(q || origin.active
                        ? {}
                        : { counts: categoryCounts(categoryFilter.usage) }),
                    })
                  : {
                      getKey: (skill) =>
                        groupMode === "scope"
                          ? t(skillScopeKey(skillScope(skill)))
                          : t(skillStateLabelKey(skill.status)),
                    }
            }
            infinite={list.infinite}
            total={list.total}
            getRowId={(skill) => skill.id}
            toolbar={
              <>
                <FilterBar
                  search={{
                    value: search,
                    onChange: setSearch,
                    placeholder: t("skills.search"),
                    testId: "skills-search",
                  }}
                  selects={[
                    ...(categoryFilter.select ? [categoryFilter.select] : []),
                    origin.select,
                  ]}
                  reset={{
                    label: t("catalog.clearFilters"),
                    onClick: () => {
                      setSearch("");
                      categoryFilter.select?.onChange("all");
                      origin.setValue("all");
                    },
                  }}
                />
                {origin.chip}
              </>
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
            hasActiveFilters={filtered}
            sorting={sorting}
            onSortingChange={setSorting}
            onOpen={(skill) => void navigate({ to: recordHref("skills", skill.id) })}
            rowHref={(skill) => recordHref("skills", skill.id)}
            rowLabel={(skill) => skill.title}
            columnsLabel={t("catalog.columns")}
            actionsLabel={t("common.actions")}
            collectionId="skills"
          />
        </div>
      )}
    </Page>
  );
}

export function SkillPage({ permissions }: { permissions: readonly string[] }): ReactNode {
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const searchStr: string = useRouterState({ select: (state) => state.location.searchStr });
  const editing = id === "new" || new URLSearchParams(searchStr).get("mode") === "edit";
  return editing ? (
    <SkillEditor id={id} permissions={permissions} search={searchStr} />
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

function actorName(directory: ActorDirectory, id: string | null, t: Translate): string {
  return (
    actorDirectoryName(directory, "user", id) ??
    actorDirectoryName(directory, "system_account", id) ??
    t("runs.caller.unknown")
  );
}

function Chip({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className={chipClass("md")}>
      {Icon ? <Icon aria-hidden="true" className="text-muted-foreground" /> : null}
      {children}
    </span>
  );
}

function whereChips(appliesTo: string | null | undefined): SkillAppliesTo[] {
  if (appliesTo === "chat" || appliesTo === "authoring") return [appliesTo];
  return ["chat", "authoring"];
}

function useSkillHistory(
  id: string,
  enabled: boolean,
  live?: ReturnType<typeof useLiveQueryOptions>,
) {
  return useQuery({
    queryKey: ["skill", id, "history"],
    queryFn: () =>
      apiRequest<{ items: SkillHistoryEntry[] }>(`${ENDPOINT}/${encodeURIComponent(id)}/history`),
    enabled,
    ...live,
  });
}

function SkillRecord({ id, permissions }: { id: string; permissions: readonly string[] }) {
  const { t, dateTime, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const canRead = permissions.includes("skill:read");
  const canWrite = permissions.includes("skill:write");
  const canActivate = permissions.includes("skill:activate");
  const canArchive = permissions.includes("skill:archive");
  const canDelete = permissions.includes("skill:delete");
  const canChat = permissions.includes("conversation:write");
  const query = useSkill(id, canRead);
  const history = useSkillHistory(id, canRead && query.data?.status === "active");
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
  const skill = query.data;
  const back = { to: "/skills", label: t("nav.skills") };

  if (!canRead)
    return (
      <DetailPage testId="detail-skills" back={back} title={t("nav.skills")}>
        <ForbiddenState />
      </DetailPage>
    );

  const active = skill?.status === "active";
  const scope = skill ? t(skillScopePhraseKey(skillScope(skill))) : "";
  const where = skill ? t(skillWhereKey(skill.applies_to)) : "";
  const strip = !skill
    ? null
    : active
      ? {
          tone: "ok" as const,
          line: t("skills.strip.active", {
            scope,
            when: formatRelativeTime(
              locale,
              skillChangedAt(
                skill,
                history.data ? skillVersionRows(history.data.items, skill.version) : null,
              ),
            ),
          }),
        }
      : {
          tone: "warn" as const,
          line: t(skill.status === "draft" ? "skills.strip.draft" : "skills.strip.disabled"),
          action: canActivate ? (
            <Button
              variant="outline"
              onClick={() => lifecycle.mutate("activate")}
              data-testid="skill-activate"
            >
              {t("skills.activate")}
            </Button>
          ) : undefined,
        };
  const menu = skill
    ? [
        ...(canChat
          ? [
              {
                label: t("detail.changeInChat"),
                href: absolute(
                  chatNewHref({
                    prompt: t("detail.changeRecordPrompt"),
                    references: [{ type: "skill", id: skill.id }],
                  }),
                ),
                testId: "detail-action",
              },
            ]
          : []),
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
      ]
    : [];
  const technical: Fact[] = skill
    ? [
        ...(skill.slug
          ? [
              {
                label: t("skills.fact.slug"),
                value: <span className="font-mono text-xs">@{skill.slug}</span>,
              },
            ]
          : []),
        { label: t("skills.fact.version"), value: String(skill.version) },
        { label: t("skills.fact.created"), value: dateTime(skill.created_at) },
        {
          label: t("skills.fact.id"),
          value: <span className="font-mono text-xs">{skill.id}</span>,
        },
      ]
    : [];

  return (
    <>
      <DetailPage
        testId="detail-skills"
        back={back}
        title={skill?.title ?? ""}
        badge={skill ? <CatalogCategoryChip category={recordCategory(skill)} /> : undefined}
        purpose={skill ? <CatalogPurpose record={skill} /> : undefined}
        loading={query.isPending}
        action={
          skill && canWrite ? (
            <Button asChild>
              <a href={editHref(skill.id)} data-testid="skill-edit">
                {t("skills.edit")}
              </a>
            </Button>
          ) : undefined
        }
        menu={
          menu.length > 0 ? <ActionMenu alwaysMenu items={menu} testId="detail-menu" /> : undefined
        }
        strip={strip ? { ...strip, testId: "skill-strip" } : null}
        tabs={
          skill
            ? [
                {
                  value: "content",
                  label: t("skills.tab.content"),
                  testId: "skill-tab-content",
                  content: (
                    <TabBody
                      testId="skill-content"
                      summary={t("skills.appliesTo", {
                        scope,
                        where,
                        when: dateTime(skill.updated_at),
                      })}
                      technical={<FactList items={technical} testId="skill-technical" />}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted-foreground">{t("skills.column.scope")}</span>
                        <Chip>{scope}</Chip>
                        <span className="ml-2 text-muted-foreground">
                          {t("skills.column.where")}
                        </span>
                        {whereChips(skill.applies_to).map((place) => (
                          <Chip key={place} icon={place === "chat" ? MessageSquare : Workflow}>
                            {t(skillWhereKey(place))}
                          </Chip>
                        ))}
                      </div>
                      {skill.body.trim() ? (
                        <MarkdownDocument
                          text={documentUnderTitle(skill.body, skill.title)}
                          testId="skill-preview"
                        />
                      ) : (
                        <DataState
                          state="empty"
                          line={t("skills.contentEmpty")}
                          testId="skill-content-empty"
                        />
                      )}
                    </TabBody>
                  ),
                },
                {
                  value: "usage",
                  label: t("skills.tab.usage"),
                  testId: "skill-tab-usage",
                  content: <SkillUsage skill={skill} permissions={permissions} />,
                },
                {
                  value: "versions",
                  label: t("skills.tab.versions"),
                  testId: "skill-tab-versions",
                  content: <SkillVersions skill={skill} canWrite={canWrite} />,
                },
              ]
            : undefined
        }
      >
        {query.error ? (
          <DataState
            state="error"
            line={t("detail.loadFailed")}
            onRetry={() => void query.refetch()}
            testId="detail-load-failed"
          />
        ) : null}
      </DetailPage>
      {skill && canWrite ? (
        <CatalogMetadataDialog
          kind="skill"
          id={skill.id}
          record={skill}
          open={describing}
          onOpenChange={setDescribing}
          queryKey={["skill", skill.id]}
        />
      ) : null}
      {skill ? (
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
      ) : null}
    </>
  );
}

function SkillUsage({ skill, permissions }: { skill: Skill; permissions: readonly string[] }) {
  const { t } = useI18n();
  const boundPath =
    skill.scope === "workflow" && skill.workflow_id
      ? `/v1/workflows/${encodeURIComponent(skill.workflow_id)}`
      : skill.scope === "connector" && skill.connector_id
        ? `/v1/connectors/${encodeURIComponent(skill.connector_id)}`
        : null;
  const bound = useQuery({
    queryKey: ["skill-binding", boundPath],
    queryFn: () => apiRequest<{ name?: string | null }>(boundPath ?? ""),
    enabled:
      Boolean(boundPath) &&
      permissions.includes(skill.scope === "workflow" ? "workflow:read" : "connector:read"),
    retry: false,
  });
  const intake = useQuery({
    queryKey: ["intake", "skill-backlinks", skill.id],
    queryFn: () => listIntakeClips(),
    enabled: permissions.includes("intake:read"),
  });
  const origins = (intake.data?.items ?? []).filter(
    (item) => item.admitted_target_kind === "skill" && item.admitted_target_id === skill.id,
  );
  const scope = skillScope(skill);
  const cards: UsageCard[] =
    scope === "workflow" && skill.workflow_id
      ? [
          {
            id: skill.workflow_id,
            title: bound.data?.name?.trim() || t("skills.scope.workflow"),
            line: t("skills.usage.workflowLine"),
            href: workflowHref(skill.workflow_id),
            icon: <Workflow />,
          },
        ]
      : scope === "connector" && skill.connector_id
        ? [
            {
              id: skill.connector_id,
              title: bound.data?.name?.trim() || t("skills.scope.connector"),
              line: t("skills.usage.connectorLine"),
              href: connectorHref(skill.connector_id),
              icon: <Cable />,
            },
          ]
        : [];
  return (
    <TabBody
      testId="skill-usage"
      summary={t("skills.usage.summary", {
        where: t(skillWhereKey(skill.applies_to)),
        scope: t(skillScopePhraseKey(scope)),
      })}
      more={
        <>
          {origins.length > 0 ? (
            <CollapsibleSection
              label={t("skills.usage.origin")}
              count={origins.length}
              testId="skill-origin"
            >
              <UsageCards
                testId="skill-origin-items"
                items={origins.map((item) => ({
                  id: item.id,
                  title: item.title,
                  line: t("skills.usage.originLine"),
                  href: recordHref("intake", item.id),
                  icon: <Inbox />,
                }))}
              />
            </CollapsibleSection>
          ) : null}
          {permissions.includes("conversation:read") ? (
            <ConversationsAbout target={{ skill_id: skill.id }} />
          ) : null}
        </>
      }
    >
      {cards.length > 0 ? (
        <UsageCards items={cards} testId="skill-binding" />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid={`skill-usage-${scope}`}>
          {scope === "template"
            ? t("skills.usage.template", {
                templates: skillTemplates(skill)
                  .map((slug) => `„${slug}“`)
                  .join(", "),
              })
            : t(scope === "unbound" ? "skills.usage.unbound" : "skills.usage.everywhere")}
        </p>
      )}
    </TabBody>
  );
}

function SkillVersions({ skill, canWrite }: { skill: Skill; canWrite: boolean }) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const directory = useActorDirectory(true);
  const [selected, setSelected] = useSearchParamState("version", "");
  const history = useSkillHistory(skill.id, true, live);
  const restore = useMutation({
    mutationFn: (entry: SkillVersionRow) =>
      apiRequest<Skill>(`${ENDPOINT}/${encodeURIComponent(skill.id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ audit_entry_id: entry.audit_entry_id }),
      }),
    onSuccess: (saved) => {
      toast.success(t("skills.versions.restored", { version: saved.version }));
      client.setQueryData(["skill", saved.id], saved);
      void client.invalidateQueries({ queryKey: ["skill", saved.id, "history"] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      setSelected("");
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 409
          ? t("skills.conflict")
          : t("common.actionFailed"),
      ),
  });
  const rows = skillVersionRows(history.data?.items ?? [], skill.version);
  const gap = skillHistoryGap(rows, skill.version);
  const open = rows.find((row) => row.audit_entry_id === selected) ?? null;
  const label = (row: SkillVersionRow) =>
    row.version === null
      ? t("skills.versions.unnumbered")
      : t("skills.versions.entry", { version: row.version });
  return (
    <TabBody
      testId="skill-versions"
      summary={
        history.data
          ? t(
              keptVersionCount(rows.length) === 1 ? "skills.versions.one" : "skills.versions.other",
              { count: keptVersionCount(rows.length) },
            )
          : undefined
      }
    >
      {history.isPending ? (
        <DataState state="loading" />
      ) : history.error ? (
        <DataState
          state="error"
          line={t("skills.versions.loadFailed")}
          onRetry={() => void history.refetch()}
          testId="skill-versions-failed"
        />
      ) : rows.length === 0 ? (
        <DataState state="empty" line={t("skills.versions.empty")} testId="skill-versions-empty" />
      ) : (
        <Timeline
          testId="skill-versions-timeline"
          groups={[
            {
              items: rows.map((row) => ({
                id: row.audit_entry_id,
                tone: row.current ? "info" : "neutral",
                title: label(row),
                meta: `${t(skillStateLabelKey(row.lifecycle ?? "active"))} · ${actorName(directory, row.actor_id, t)}`,
                aside: (
                  <>
                    {row.current ? (
                      <StatusBadge state="active" label={t("knowledge.versions.current")} />
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {dateTime(row.updated_at)}
                    </span>
                  </>
                ),
                onOpen: () => setSelected(row.audit_entry_id),
                label: label(row),
                testId: `skill-version-${row.audit_entry_id}`,
              })),
            },
          ]}
        />
      )}
      {history.data && gap ? (
        <p className="text-sm text-muted-foreground" data-testid="skill-versions-gap">
          {gap.through === 1
            ? t("skills.versions.gap.one")
            : t("skills.versions.gap.other", { through: gap.through })}
        </p>
      ) : null}
      <SkillVersionSheet
        skillId={skill.id}
        row={open}
        rows={rows}
        label={open ? label(open) : ""}
        canWrite={canWrite}
        restoring={restore.isPending}
        onRestore={(row) => restore.mutateAsync(row)}
        directory={directory}
        onClose={() => setSelected("")}
      />
    </TabBody>
  );
}

function SkillVersionSheet({
  skillId,
  row,
  rows,
  label,
  canWrite,
  restoring,
  onRestore,
  directory,
  onClose,
}: {
  skillId: string;
  row: SkillVersionRow | null;
  rows: readonly SkillVersionRow[];
  label: string;
  canWrite: boolean;
  restoring: boolean;
  onRestore: (row: SkillVersionRow) => Promise<unknown>;
  directory: ActorDirectory;
  onClose: () => void;
}) {
  const { t, dateTime } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const entryId = row?.audit_entry_id ?? "";
  const detail = useQuery({
    queryKey: ["skill", skillId, "history", entryId],
    queryFn: () =>
      apiRequest<SkillHistoryDetail>(
        `${ENDPOINT}/${encodeURIComponent(skillId)}/history/${encodeURIComponent(entryId)}`,
      ),
    enabled: row?.has_snapshot === true,
  });
  const change = detail.data ? skillVersionChange(detail.data) : null;
  const basis = row ? skillVersionBasis(rows, row) : null;
  const author = row ? actorName(directory, row.actor_id, t) : "";
  const facts: Fact[] = row
    ? [
        { label: t("knowledge.versions.savedBy"), value: author },
        { label: t("knowledge.versions.at"), value: dateTime(row.updated_at) },
        {
          label: t("resource.field.status"),
          value: t(skillStateLabelKey(row.lifecycle ?? "active")),
        },
        ...(row.title ? [{ label: t("common.name"), value: row.title }] : []),
        ...(change?.renamedFrom
          ? [{ label: t("skills.versions.renamedFrom"), value: change.renamedFrom }]
          : []),
      ]
    : [];
  return (
    <RecordSheet
      open={row !== null}
      onOpenChange={(next) => !next && onClose()}
      title={label}
      subtitle={row ? `${author} · ${dateTime(row.updated_at)}` : undefined}
      badge={
        row?.current ? (
          <StatusBadge state="active" label={t("knowledge.versions.current")} />
        ) : undefined
      }
      action={
        row && canWrite && row.restorable ? (
          <Button
            pending={restoring}
            onClick={() => setConfirming(true)}
            data-testid="skill-version-restore"
          >
            {t("knowledge.versions.restore")}
          </Button>
        ) : undefined
      }
      testId="skill-version-sheet"
      closeTestId="skill-version-close"
    >
      {row ? (
        <div className="flex flex-col gap-6">
          <FactList testId="skill-version-facts" items={facts} />
          {!row.has_snapshot ? null : detail.isPending ? (
            <DataState state="loading" />
          ) : detail.error ? (
            <DataState
              state="error"
              line={t("skills.versions.loadFailed")}
              onRetry={() => void detail.refetch()}
              testId="skill-version-failed"
            />
          ) : change ? (
            <VersionChange
              label={
                basis !== null
                  ? t("knowledge.versions.changeSince", { version: basis })
                  : t("skills.versions.change")
              }
              rows={change.rows}
              testId="skill-version"
            />
          ) : null}
          <p className="text-sm text-muted-foreground" data-testid="skill-version-hint">
            {row.current
              ? t("skills.versions.currentHint")
              : row.restorable
                ? t("skills.versions.restoreHint")
                : t("skills.versions.noSnapshot")}
          </p>
          <CollapsibleSection label={t("common.technical")} testId="skill-version-technical">
            <FactList
              items={[
                {
                  label: t("skills.versions.auditEntry"),
                  value: <span className="font-mono text-xs">{row.audit_entry_id}</span>,
                },
              ]}
            />
          </CollapsibleSection>
          <RestoreVersionConfirm
            open={confirming}
            onOpenChange={setConfirming}
            pending={restoring}
            onConfirm={() => onRestore(row)}
            testId="skill-version-restore-confirm"
          />
        </div>
      ) : null}
    </RecordSheet>
  );
}

function SkillEditor({
  id,
  permissions,
  search,
}: {
  id: string;
  permissions: readonly string[];
  search: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const client = useQueryClient();
  const isNew = id === "new";
  const canWrite = permissions.includes("skill:write");
  const query = useSkill(id, permissions.includes("skill:read"));
  const skill = query.data;
  const template = isNew ? skillTemplateFromSearch(search) : null;
  const original = {
    title: skill?.title ?? "",
    body: skill?.body ?? "",
    appliesTo: (skill?.applies_to ?? "both") as SkillAppliesTo,
  };
  const [title, setTitle] = useState(() =>
    template ? t(skillTemplateKeys(template).title) : original.title,
  );
  const [body, setBody] = useState(() =>
    template ? t(skillTemplateKeys(template).body) : original.body,
  );
  const [appliesTo, setAppliesTo] = useState<SkillAppliesTo>(original.appliesTo);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (isNew) return;
    setTitle(skill?.title ?? "");
    setBody(skill?.body ?? "");
    setAppliesTo((skill?.applies_to ?? "both") as SkillAppliesTo);
  }, [isNew, skill?.title, skill?.body, skill?.applies_to]);
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
    if (!title.trim()) return setProblem(t("skills.nameMissing"));
    if (!body.trim()) return setProblem(t("skills.bodyMissing"));
    save.mutate();
  };
  const applyTemplate = (next: SkillTemplate) => {
    const keys = skillTemplateKeys(next);
    if (!title.trim()) setTitle(t(keys.title));
    setBody(t(keys.body));
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
      <div className="grid gap-4 sm:grid-cols-2">
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
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="skill-body">{t("skills.editor.body")}</FieldLabel>
          {isNew ? (
            <div
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              data-testid="skill-templates"
            >
              {t("skills.editor.useTemplate")}
              {SKILL_TEMPLATES.map((entry) => {
                const Icon = TEMPLATE_ICONS[entry];
                return (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => applyTemplate(entry)}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`skill-template-${entry}`}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                    {t(skillTemplateKeys(entry).title)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <MarkdownEditor
            id="skill-body"
            label={t("skills.editor.body")}
            value={body}
            onChange={setBody}
            placeholder={t("skills.editor.bodyPlaceholder")}
            rows={16}
            invalid={problem === t("skills.bodyMissing")}
            testId="skill-body"
          />
        </Field>
        {problem && !dirty ? (
          <FieldError className="sm:col-span-2" data-testid="skill-editor-error">
            {problem}
          </FieldError>
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
