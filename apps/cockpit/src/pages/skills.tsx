import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import { listProposedSkillCandidates, type SkillCandidate } from "@/api/decisions";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, recordHref, routerTarget } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useDirtyGuard } from "@/app/version-notice";
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
import { queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";
import { SkillProposalSheet } from "@/pages/skill-proposal-sheet";
import {
  SKILL_APPLIES_TO,
  type SkillAppliesTo,
  skillAppliesToOptionKey,
  skillScopeKey,
  skillStateLabelKey,
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

function rowScopeKey(row: SkillRow) {
  return row.kind === "skill"
    ? skillScopeKey(row.skill.scope, row.skill.applies_to)
    : skillScopeKey(row.candidate.scope);
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
  const q = useDebouncedValue(search).trim();
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [first] = sorting;
  const list = useInfiniteList<Skill>(
    ENDPOINT,
    { q: q || undefined, sort: first?.id ?? "updated_at", order: first?.desc ? "desc" : "asc" },
    { enabled: canRead },
  );
  const proposals = useQuery({
    queryKey: PROPOSALS_KEY,
    queryFn: listProposedSkillCandidates,
    enabled: canRead,
    ...live,
  });
  const open = proposals.data?.items ?? [];
  const proposal = open.find((candidate) => candidate.id === proposalId) ?? null;
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
        (row) => rowTitle(row),
        {
          sortable: true,
          width: "w-[44%]",
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
        { sortable: true, width: "w-[16%]" },
      ),
      {
        ...column.custom(
          "scope",
          (row) => rowScope(row),
          t("skills.column.scope"),
          (row) => t(rowScopeKey(row)),
          { sortable: true, width: "w-[20%]" },
        ),
        meta: { width: "w-[20%]", priority: "low" },
      },
      column.date(
        "updated_at",
        (row) => (row.kind === "skill" ? row.skill.updated_at : row.candidate.updated_at),
        t("skills.column.changed"),
        { sortable: true, width: "w-[20%]" },
      ),
    ];
  }, [t, dateTime]);

  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="catalog-skills"
        header={<PageHeader eyebrow={t("nav.group.knowledge")} title={title} />}
      >
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
      </Page>
    );

  const rows: SkillRow[] = [
    ...(q ? [] : open.map((candidate) => ({ kind: "proposal" as const, candidate }))),
    ...list.items.map((skill) => ({ kind: "skill" as const, skill })),
  ];
  const pending = list.query.isPending && !list.query.failureReason;
  const failed = Boolean(list.query.error || list.query.failureReason);
  const empty = !pending && !failed && rows.length === 0 && !q;
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
          {rows.length > 0 ? (
            <SummaryLine
              text={skillsLine(t, list.total ?? list.items.length, open.length)}
              help={t("skills.summaryHelp")}
              testId="skills-summary"
            />
          ) : null}
          <DataTable
            columns={columns}
            data={rows}
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
              />
            }
            pending={pending}
            error={
              failed
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void list.query.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: { title: t("skills.empty"), action: newButton("skills-empty-new") },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: () => setSearch(""),
              },
            }}
            hasActiveFilters={Boolean(q)}
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
  if (!canRead)
    return frame(
      <DataState
        state="empty"
        line={t("resource.permission.description")}
        testId="resource-permission-alert"
      />,
    );
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
                    chatNewHref({ prompt: t("detail.changeRecordPrompt", { name: skill.title }) }),
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
              scope: t(skillScopeKey(skill.scope, skill.applies_to)),
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
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
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
          <FilePreview
            name=""
            mimeType="text/markdown"
            text={documentUnderTitle(body, title)}
            testId="skill-editor-preview-body"
          />
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
