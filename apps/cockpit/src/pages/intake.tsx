import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import {
  ArrowRight,
  Bookmark,
  MessageSquareText,
  PenLine,
  Puzzle,
  StickyNote,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  type CreateIntakeClipInput,
  createIntakeClip,
  deleteDiscardedIntakeClip,
  getIntakeDefaultCategory,
  type IntakeClip,
  type IntakeProposal,
  type IntakeSnapshot,
  listIntakeCategories,
  listIntakeClips,
  setIntakeDefaultCategory,
} from "@/api/intake";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, docsHref, recordHref } from "@/app/links";
import { CatalogCategories } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChips,
  catalogCategoryGrouping,
} from "@/components/cockpit/catalog-grouping";
import {
  categoryChoices,
  normalizeCategoryInput,
} from "@/components/cockpit/catalog-metadata-model";
import { FocusedDiff } from "@/components/cockpit/diff-card";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  Chip,
  type CockpitColumn,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DataTable,
  Field,
  FieldError,
  FieldLabel,
  FilePreview,
  FilterBar,
  type FilterSelect,
  FormDialog,
  GroupingTabs,
  IconTile,
  type IconTileSize,
  MarkdownEditor,
  OnboardingFrame,
  Page,
  PageHeader,
  rowsByGroup,
  Section,
  SectionHeading,
  StatusBadge,
  SummaryLine,
  SummaryParts,
  type TableSelection,
} from "@/components/cockpit/patterns";
import { AssistantIcon } from "@/components/cockpit/service-icon";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useSearchParamState, writeSearchParam } from "@/lib/use-search-param-state";
import { cn } from "@/lib/utils";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import {
  changedSkillLine,
  INTAKE_ORIGINS,
  INTAKE_STATES,
  type IntakeOrigin,
  intakeAssistant,
  intakeAwaitingAssistantReview,
  intakeCategoryFromSearch,
  intakeChatPrompt,
  intakeNeedsAssistantReview,
  intakeNoteRequest,
  intakeOrigin,
  intakeOriginLabel,
  intakeOriginLabelKey,
  intakeStateLabelKey,
  isSkillTarget,
  mayConfirmIntakeProposal,
  newSkillLine,
  type ReferencedSkill,
  sessionSnapshot,
  skillBodyChange,
  skillConventionsView,
  skillTargetIds,
} from "./intake-model";

export const CATEGORIES_KEY = ["intake", "categories"] as const;
export const DEFAULT_CATEGORY_KEY = ["intake", "default-category"] as const;
export const CLIPS_KEY = ["intake", "clips"] as const;
const NEW_CATEGORY = "__new__";

const INTAKE_WAYS = [
  { key: "clipper", icon: Puzzle, href: docsHref("web-clipper") },
  { key: "session", icon: MessageSquareText, href: docsHref("use-sk-from-a-coding-agent") },
] as const;

const INTAKE_FLOW = ["collect", "propose", "confirm", "knowledge"] as const;

export function IntakeOriginIcon({
  snapshot,
  tile,
  size = "size-3.5",
}: {
  snapshot: IntakeSnapshot;
  tile?: IconTileSize;
  size?: string;
}) {
  const session = sessionSnapshot(snapshot);
  if (session)
    return (
      <AssistantIcon
        mark={intakeAssistant(session).mark}
        tile={tile}
        {...(tile ? {} : { className: size })}
      />
    );
  const Icon = intakeOrigin(snapshot) === "note" ? PenLine : Bookmark;
  if (!tile)
    return <Icon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", size)} />;
  return (
    <IconTile size={tile}>
      <Icon />
    </IconTile>
  );
}

export function IntakeOnboarding({ onAddNote }: { onAddNote?: () => void }) {
  const { t } = useI18n();
  return (
    <OnboardingFrame lead={t("intake.onboarding.lead")} testId="intake-onboarding">
      <ul className={onAddNote ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
        {INTAKE_WAYS.map((way) => (
          <li key={way.key} className="flex h-full flex-col gap-2 rounded-lg border p-4">
            <IconTile>
              <way.icon />
            </IconTile>
            <span className="text-sm font-medium">{t(`intake.onboarding.${way.key}.title`)}</span>
            <span className="flex-1 text-xs text-muted-foreground">
              {t(`intake.onboarding.${way.key}.line`)}
            </span>
            <Button variant="outline" size="sm" className="w-fit" asChild>
              <a href={absolute(way.href)} data-testid={`intake-onboarding-${way.key}`}>
                {t(`intake.onboarding.${way.key}.action`)}
              </a>
            </Button>
          </li>
        ))}
        {onAddNote ? (
          <li className="flex h-full flex-col gap-2 rounded-lg border p-4">
            <IconTile>
              <StickyNote />
            </IconTile>
            <span className="text-sm font-medium">{t("intake.onboarding.note.title")}</span>
            <span className="flex-1 text-xs text-muted-foreground">
              {t("intake.onboarding.note.line")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={onAddNote}
              data-testid="intake-onboarding-note"
            >
              {t("intake.onboarding.note.action")}
            </Button>
          </li>
        ) : null}
      </ul>
      <section
        className="rounded-lg border p-4"
        aria-labelledby="intake-onboarding-flow"
        data-testid="intake-onboarding-flow"
      >
        <SectionHeading id="intake-onboarding-flow">{t("intake.onboarding.flow")}</SectionHeading>
        <ol className="mt-3 flex flex-col gap-3 text-sm sm:flex-row sm:items-center">
          {INTAKE_FLOW.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span className="inline-grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums">
                {index + 1}
              </span>
              {t(`intake.onboarding.flow.${step}`)}
              {index < INTAKE_FLOW.length - 1 ? (
                <ArrowRight
                  aria-hidden="true"
                  className="ml-2 hidden size-4 text-muted-foreground sm:inline-block"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </OnboardingFrame>
  );
}

export function invalidateIntake(queryClient: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return queryClient.invalidateQueries({ queryKey: ["intake"] });
}

export function IntakeEditDialog({
  clip,
  categories,
  open,
  pending,
  error,
  conflict,
  onReload,
  onOpenChange,
  onSave,
}: {
  clip: IntakeClip | null;
  categories: string[];
  open: boolean;
  pending: boolean;
  error: string | null;
  conflict: boolean;
  onReload(): void;
  onOpenChange(open: boolean): void;
  onSave(
    clip: IntakeClip,
    input: {
      expected_version: number;
      category?: string;
      title?: string;
      body?: string;
      note?: string;
    },
  ): void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(clip?.title ?? "");
  const [body, setBody] = useState(clip?.body ?? "");
  const [choice, setChoice] = useState(clip?.category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(clip?.title ?? "");
    setBody(clip?.body ?? "");
    setChoice(clip?.category ?? "");
    setFresh("");
  }, [clip, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const trimmedTitle = title.trim();
  const choices = categoryChoices(categories, clip?.category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  const changed =
    clip !== null &&
    (trimmedTitle !== clip.title || body !== clip.body || category !== clip.category);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.editItem")}
      size="wide"
      submit={{
        label: t("common.save"),
        pending,
        disabled: !clip || !trimmedTitle || !body || !category || !changed,
        testId: "intake-edit-save",
      }}
      onSubmit={() => {
        if (!clip || !trimmedTitle || !body || !category || !changed) return;
        onSave(clip, {
          expected_version: clip.version,
          ...(trimmedTitle !== clip.title ? { title: trimmedTitle } : {}),
          ...(body !== clip.body ? { body } : {}),
          ...(category !== clip.category ? { category } : {}),
        });
      }}
      error={error}
      actions={
        conflict ? (
          <Button
            type="button"
            variant="outline"
            onClick={onReload}
            data-testid="intake-edit-reload"
          >
            {t("settings.reload")}
          </Button>
        ) : undefined
      }
      testId="intake-edit-dialog"
    >
      <TextField
        id="intake-edit-title"
        label={t("resource.field.title")}
        value={title}
        onChange={setTitle}
        error={title && !trimmedTitle ? t("intake.editTitleRequired") : null}
      />
      <Field>
        <FieldLabel htmlFor="intake-edit-body">{t("knowledge.content")}</FieldLabel>
        <MarkdownEditor
          id="intake-edit-body"
          label={t("knowledge.content")}
          value={body}
          onChange={setBody}
          rows={10}
          invalid={!body}
          testId="intake-edit-body"
        />
        {!body ? <FieldError>{t("intake.editBodyRequired")}</FieldError> : null}
      </Field>
      <p className="text-xs text-muted-foreground">{t("intake.editKeepsKnowledge")}</p>
      <SelectField
        id="intake-edit-category"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-edit-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

export function IntakeNoteDialog({
  categories,
  initialCategory,
  open,
  onOpenChange,
  onCreated,
}: {
  categories: string[];
  initialCategory: string | undefined;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(clip: IntakeClip): void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [choice, setChoice] = useState(initialCategory ?? "");
  const [fresh, setFresh] = useState("");
  const attempt = useRef<{ content: string; id: string; at: Date } | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setChoice(initialCategory ?? "");
    setFresh("");
    setTouched(false);
    attempt.current = null;
  }, [initialCategory, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const choices = categoryChoices(categories, initialCategory ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  const create = useMutation({
    mutationFn: (input: CreateIntakeClipInput) => createIntakeClip(input),
    onSuccess: async (clip) => {
      await invalidateIntake(queryClient);
      onCreated(clip);
    },
  });
  const invalidCategory = choice === NEW_CATEGORY && !freshCategory;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.add.title")}
      size="wide"
      submit={{
        label: t("intake.add.submit"),
        pending: create.isPending,
        disabled: invalidCategory,
        testId: "intake-add-submit",
      }}
      onSubmit={() => {
        setTouched(true);
        if (invalidCategory) return;
        const content = JSON.stringify([title, body, category]);
        if (attempt.current?.content !== content)
          attempt.current = { content, id: crypto.randomUUID(), at: new Date() };
        const request = intakeNoteRequest({
          clientRequestId: attempt.current.id,
          title,
          body,
          category,
          capturedAt: attempt.current.at,
        });
        if (request) create.mutate(request);
      }}
      error={create.error ? t("intake.add.failed") : null}
      testId="intake-add-dialog"
    >
      <TextField
        id="intake-add-title"
        label={t("resource.field.title")}
        value={title}
        onChange={setTitle}
        error={touched && !title.trim() ? t("intake.editTitleRequired") : null}
      />
      <Field>
        <FieldLabel htmlFor="intake-add-body">{t("knowledge.content")}</FieldLabel>
        <MarkdownEditor
          id="intake-add-body"
          label={t("knowledge.content")}
          value={body}
          onChange={setBody}
          rows={10}
          invalid={touched && !body.trim()}
          testId="intake-add-body"
        />
        {touched && !body.trim() ? <FieldError>{t("intake.editBodyRequired")}</FieldError> : null}
      </Field>
      <SelectField
        id="intake-add-category"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-add-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">{t("intake.add.hint")}</p>
    </FormDialog>
  );
}

function IntakeDefaultCategoryDialog({
  category,
  initialCategory,
  categories,
  open,
  onOpenChange,
  onSave,
}: {
  category: string | undefined;
  initialCategory: string | undefined;
  categories: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(category: string): void;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState(initialCategory ?? category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setChoice(initialCategory ?? category ?? "");
    setFresh("");
  }, [category, initialCategory, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const selected = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const choices = categoryChoices(categories, category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.makeDefault")}
      submit={{
        label: t("common.save"),
        disabled: !selected || selected === category,
        testId: "intake-default-category-save",
      }}
      onSubmit={() => {
        if (selected && selected !== category) onSave(selected);
      }}
      testId="intake-default-category-dialog"
    >
      <SelectField
        id="intake-default-category-input"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-default-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

type Skill = components["schemas"]["Skill"];

function SkillChange({
  proposalId,
  skillId,
  line,
  skill,
  body,
}: {
  proposalId: string;
  skillId: string;
  line: string;
  skill: ReferencedSkill | undefined;
  body: string;
}) {
  const { t } = useI18n();
  if (!skill) return null;
  const rows = skillBodyChange(skill.body, body);
  return (
    <Section
      label={t("intake.proposal.changeTo", { skill: skill.title })}
      testId={`intake-proposal-${proposalId}-change-${skillId}`}
    >
      <p className="mb-2 text-sm text-muted-foreground">{line}</p>
      {rows.length ? (
        <FocusedDiff rows={rows} testId={`intake-proposal-${proposalId}-diff-${skillId}`} />
      ) : (
        <p className="text-sm">{t("intake.proposal.unchanged")}</p>
      )}
    </Section>
  );
}

export function ProposalCard({
  proposal,
  permissions,
  onConfirm,
  onReject,
  focused = false,
}: {
  proposal: IntakeProposal;
  permissions: readonly string[];
  onConfirm(): void;
  onReject?(): void;
  focused?: boolean;
}) {
  const { t, dateTime } = useI18n();
  const [confirmingRevision, setConfirmingRevision] = useState<number | null>(null);
  const [rejectingRevision, setRejectingRevision] = useState<number | null>(null);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) card.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focused]);
  const proposed = proposal.revision.target;
  const skillTarget = isSkillTarget(proposed) ? proposed : null;
  const knowledgeId = "knowledge_source_id" in proposed ? proposed.knowledge_source_id : null;
  const knowledge = useQuery({
    queryKey: ["knowledge-source", "intake-target", knowledgeId],
    queryFn: () =>
      apiRequest<{ name: string; category: string; tags: string[] }>(
        `/v1/knowledge-sources/${encodeURIComponent(knowledgeId ?? "")}`,
      ),
    enabled: Boolean(knowledgeId),
  });
  const skillIds = skillTarget ? skillTargetIds(skillTarget) : [];
  const skillQueries = useQueries({
    queries: skillIds.map((id) => ({
      queryKey: ["skill", "intake-target", id],
      queryFn: () => apiRequest<Skill>(`/v1/skills/${encodeURIComponent(id)}`),
    })),
  });
  const skills = new Map<string, ReferencedSkill | undefined>(
    skillIds.map((id, index) => [id, skillQueries[index]?.data]),
  );
  const created = skillTarget?.skill.new;
  const bindingPath = created?.connector_id
    ? `/v1/connectors/${encodeURIComponent(created.connector_id)}`
    : created?.workflow_id
      ? `/v1/workflows/${encodeURIComponent(created.workflow_id)}`
      : null;
  const binding = useQuery({
    queryKey: ["intake-target-binding", bindingPath],
    queryFn: () => apiRequest<{ name: string }>(bindingPath ?? ""),
    enabled: Boolean(bindingPath) && (proposal.status === "draft" || proposal.status === "stale"),
    retry: false,
    retryOnMount: false,
  });
  const bindingSettled = !bindingPath || binding.isSuccess || binding.isError;
  const bindingName =
    binding.data?.name ?? (binding.isError ? t("intake.target.hiddenName") : null);
  const bindingMissing = binding.error instanceof ApiError && binding.error.status === 404;
  const targetMissing = skillQueries.some((query) => query.isError) || bindingMissing;
  const targetsLoaded = knowledgeId
    ? Boolean(knowledge.data)
    : skillQueries.every((query) => Boolean(query.data)) && bindingSettled;
  const canConfirm = mayConfirmIntakeProposal(proposed, permissions);
  const canReject = permissions.includes("intake:write") && onReject !== undefined;
  const existingSkillId = skillTarget?.skill.skill_id ?? null;
  const existingSkill = existingSkillId ? skills.get(existingSkillId) : undefined;
  const skillMoved =
    existingSkill !== undefined &&
    skillTarget?.skill.expected_version !== undefined &&
    existingSkill.version !== skillTarget.skill.expected_version;
  const destination =
    "name" in proposed
      ? proposed
      : skillTarget
        ? skillTarget.skill.new
          ? { name: skillTarget.skill.new.title, ...skillTarget.skill.new }
          : existingSkill
            ? { name: existingSkill.title, category: undefined, tags: undefined }
            : undefined
        : knowledge.data;
  const knownTargetName = destination?.name ?? null;
  const targetName =
    knownTargetName ??
    t(skillTarget ? "intake.target.selectedSkillName" : "intake.proposal.loadingTarget");
  const existingInactive = existingSkill?.status !== undefined && existingSkill.status !== "active";
  const targetCategory = destination?.category;
  const targetTags = destination?.tags?.join(", ");
  const skillLines = skillTarget
    ? [
        ...(skillTarget.skill.new
          ? [{ id: "new", line: newSkillLine(skillTarget, t, bindingName) ?? "" }]
          : []),
        ...(existingSkillId
          ? [
              {
                id: existingSkillId,
                line: `${changedSkillLine(
                  "update",
                  existingSkill,
                  skillTarget.skill.expected_version,
                  t,
                )}${existingInactive ? ` · ${t("intake.target.activates")}` : ""}`,
              },
            ]
          : []),
        ...skillTarget.skill.supersedes.map((entry) => ({
          id: entry.skill_id,
          line: changedSkillLine("replace", skills.get(entry.skill_id), entry.expected_version, t),
        })),
      ]
    : [];
  const archived = skillTarget
    ? skillTarget.skill.supersedes.map(
        (entry) => skills.get(entry.skill_id)?.title ?? t("intake.target.selectedSkillName"),
      )
    : [];
  const conventions = skillTarget ? skillConventionsView(skillTarget, existingSkill, t) : null;
  const conventionDetails = conventions
    ? [
        conventions.rules.length
          ? `${t("intake.proposal.rules")}: ${conventions.rules.join("; ")}.`
          : t("intake.proposal.rulesNone"),
        `${t("intake.proposal.ruleDomains", { domains: conventions.domains })}.`,
      ]
    : [];
  const confirmationDetails = [
    skillTarget
      ? knownTargetName
        ? t("intake.proposal.confirmSkillHelp", { target: knownTargetName })
        : t("intake.proposal.confirmSkillHelpUnnamed")
      : t("intake.proposal.confirmHelp", { target: targetName }),
    ...(skillLines.length ? [`${skillLines.map((entry) => entry.line).join(". ")}.`] : []),
    ...(archived.length ? [t("intake.proposal.archives", { skills: archived.join(", ") })] : []),
    ...conventionDetails,
    ...(targetCategory ? [`${t("intake.proposal.category")}: ${targetCategory}`] : []),
    ...(targetTags ? [`${t("intake.proposal.tags")}: ${targetTags}`] : []),
  ].join(" ");
  const confirmLabel = t(skillTarget ? "intake.proposal.confirmSkill" : "intake.proposal.confirm");
  const open = proposal.status === "draft";
  return (
    <article
      ref={card}
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid={`intake-proposal-${proposal.id}`}
      data-focused={focused || undefined}
      data-slot="proposal-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip testId={`intake-proposal-${proposal.id}-kind`}>
          {t(skillTarget ? "intake.proposal.kindSkill" : "intake.proposal.kindKnowledge")}
        </Chip>
        {proposal.status === "draft" ? null : (
          <StatusBadge state={proposal.status} label={t(`intake.proposal.${proposal.status}`)} />
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("intake.proposal.proposedAt", { when: dateTime(proposal.created_at) })}
        </span>
      </div>
      <p className="font-medium">{proposal.revision.title}</p>
      <p
        className="text-sm text-muted-foreground"
        data-testid={`intake-proposal-${proposal.id}-target-details`}
      >
        {skillTarget
          ? skillLines.map((entry) => (
              <span key={entry.id} className="block">
                {entry.line}
              </span>
            ))
          : `${targetName}${targetCategory && targetCategory !== targetName ? ` · ${targetCategory}` : ""}`}
      </p>
      {skillLines
        .filter((entry) => entry.id !== "new")
        .map((entry) => (
          <SkillChange
            key={entry.id}
            proposalId={proposal.id}
            skillId={entry.id}
            line={entry.line}
            skill={skills.get(entry.id)}
            body={proposal.revision.body}
          />
        ))}
      {conventions ? (
        <div className="text-sm" data-testid={`intake-proposal-${proposal.id}-rules`}>
          {conventions.rules.length ? (
            <>
              <p className="font-medium">{t("intake.proposal.rules")}</p>
              <ul className="mt-1 grid gap-1">
                {conventions.rules.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="font-medium">{t("intake.proposal.rulesNone")}</p>
          )}
          <p className="mt-1 text-muted-foreground">
            {t("intake.proposal.ruleDomains", { domains: conventions.domains })}
          </p>
        </div>
      ) : null}
      <CollapsibleSection
        label={t("intake.proposal.review")}
        defaultOpen={focused && skillLines.every((entry) => entry.id === "new")}
        testId={`intake-proposal-${proposal.id}-review`}
      >
        <FilePreview
          name=""
          mimeType="text/markdown"
          text={proposal.revision.body}
          testId={`intake-proposal-${proposal.id}-body`}
        />
        {targetTags ? (
          <p className="mt-2 text-sm" data-testid={`intake-proposal-${proposal.id}-target-tags`}>
            {t("intake.proposal.tags")}: {targetTags}
          </p>
        ) : null}
        <ul className="mt-3 grid gap-2 text-sm">
          {proposal.revision.items.map((item) => (
            <li key={item.id} className="grid gap-0.5">
              <a
                className="text-accent underline-offset-4 hover:underline"
                href={absolute(recordHref("intake", item.id))}
                data-testid={`intake-proposal-${proposal.id}-source-${item.id}`}
              >
                {item.title}
              </a>
              {item.source_url || item.source_author || item.published_at ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`intake-proposal-${proposal.id}-provenance-${item.id}`}
                >
                  {[
                    item.source_url,
                    item.source_author
                      ? t("intake.proposal.sourceAuthor", { author: item.source_author })
                      : null,
                    item.published_at
                      ? t("intake.proposal.sourcePublished", { date: item.published_at })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        {proposal.revision.items.some(
          (item) => item.source_url || item.source_author || item.published_at,
        ) ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("intake.proposal.provenance")}</p>
        ) : null}
      </CollapsibleSection>
      {proposal.status === "draft" && skillMoved ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`intake-proposal-${proposal.id}-skill-moved`}
        >
          {t("intake.proposal.stale")}
        </p>
      ) : null}
      {proposal.status === "draft" && targetMissing ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`intake-proposal-${proposal.id}-target-missing`}
        >
          {t("intake.proposal.targetMissing")}
        </p>
      ) : null}
      {proposal.status === "stale" && proposal.stale_reason === "intake_item_admitted" ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`intake-proposal-${proposal.id}-admitted-elsewhere`}
        >
          {t("intake.proposal.admittedElsewhere")}
        </p>
      ) : null}
      {proposal.status === "draft" && !canConfirm ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`intake-proposal-${proposal.id}-needs-rights`}
        >
          {t("intake.proposal.needsRights")}
        </p>
      ) : null}
      {open && (canConfirm || canReject) ? (
        <div className="flex flex-wrap gap-2" data-slot="proposal-actions">
          {canConfirm ? (
            <Button
              size="sm"
              disabled={!targetsLoaded || skillMoved || targetMissing}
              onClick={() => setConfirmingRevision(proposal.current_revision)}
              data-testid={`intake-proposal-${proposal.id}-confirm`}
            >
              {confirmLabel}
            </Button>
          ) : null}
          {canReject ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRejectingRevision(proposal.current_revision)}
              data-testid={`intake-proposal-${proposal.id}-reject`}
            >
              {t("intake.proposal.reject")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {proposal.status === "confirmed" && proposal.confirmed_target_id ? (
        proposal.confirmed_target_kind === "skill" ? (
          <a
            className="block text-sm text-accent"
            href={absolute(recordHref("skills", proposal.confirmed_target_id))}
            data-testid={`intake-proposal-${proposal.id}-skill`}
          >
            {knownTargetName
              ? t("intake.openSkill", { name: knownTargetName })
              : t("intake.openSkillUnnamed")}
          </a>
        ) : proposal.confirmed_target_kind === "knowledge" ? (
          <a
            className="block text-sm text-accent"
            href={absolute(recordHref("knowledge", proposal.confirmed_target_id))}
            data-testid={`intake-proposal-${proposal.id}-knowledge`}
          >
            {t("intake.openKnowledge", { name: targetName })}
          </a>
        ) : null
      ) : null}
      <ConfirmDialog
        open={open && confirmingRevision === proposal.current_revision}
        onOpenChange={(next) => setConfirmingRevision(next ? proposal.current_revision : null)}
        object={proposal.revision.title}
        verb={confirmLabel}
        consequence={confirmationDetails}
        onConfirm={onConfirm}
        testId={`intake-proposal-${proposal.id}-confirm-dialog`}
      />
      {canReject ? (
        <ConfirmDialog
          open={open && rejectingRevision === proposal.current_revision}
          onOpenChange={(next) => setRejectingRevision(next ? proposal.current_revision : null)}
          object={t("intake.proposal.rejectObject")}
          verb={t("intake.proposal.reject")}
          consequence={t("intake.proposal.rejectConsequence")}
          onConfirm={() => onReject?.()}
          testId={`intake-proposal-${proposal.id}-reject-dialog`}
        />
      ) : null}
    </article>
  );
}

export function IntakePage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intakeSearch = useRouterState({ select: (router) => router.location.search });
  const requestedCategory = intakeCategoryFromSearch(intakeSearch);
  const canRead = permissions.includes("intake:read");
  const canWrite = permissions.includes("intake:write");
  const canChat = permissions.includes("conversation:write");
  const [category, setCategoryState] = useState<string | "all" | null>(requestedCategory);
  useEffect(() => {
    if (requestedCategory !== null) setCategoryState(requestedCategory);
  }, [requestedCategory]);
  const setCategory = (next: string | "all" | null) => {
    setCategoryState(next);
    writeSearchParam("category", next, "");
  };
  const [sorting, setSorting] = useState<SortingState>([{ id: "captured_at", desc: true }]);
  const [search, setSearch] = useSearchParamState("q", "");
  const needle = useDebouncedValue(search).trim().toLowerCase();
  const [groupMode, setGroupMode] = useSearchParamState("group", "all");
  const [settingDefaultCategory, setSettingDefaultCategory] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<IntakeClip[]>([]);
  const [deletePending, setDeletePending] = useState(false);
  const [state, setState] = useSearchParamState<"all" | (typeof INTAKE_STATES)[number]>(
    "state",
    "all",
    (value): value is (typeof INTAKE_STATES)[number] =>
      (INTAKE_STATES as readonly string[]).includes(value),
  );
  const [origin, setOrigin] = useSearchParamState<"all" | IntakeOrigin>(
    "origin",
    "all",
    (value): value is IntakeOrigin => (INTAKE_ORIGINS as readonly string[]).includes(value),
  );
  const categories = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: listIntakeCategories,
    enabled: canRead,
  });
  const defaultCategory = useQuery({
    queryKey: DEFAULT_CATEGORY_KEY,
    queryFn: getIntakeDefaultCategory,
    enabled: canRead,
  });
  const effectiveCategory =
    category === "all" ? undefined : (category ?? defaultCategory.data?.category);
  const clips = useQuery({
    queryKey: [...CLIPS_KEY, effectiveCategory, state],
    queryFn: () =>
      listIntakeClips({
        ...(effectiveCategory ? { category: effectiveCategory } : {}),
        ...(state === "all" ? {} : { state }),
      }),
    enabled: canRead,
  });
  const categoryClips = useQuery({
    queryKey: [...CLIPS_KEY, effectiveCategory, "all"],
    queryFn: () => listIntakeClips(effectiveCategory ? { category: effectiveCategory } : {}),
    enabled: canRead && state !== "all",
  });
  const categoryValues = useMemo(
    () => [
      ...new Set([
        ...(defaultCategory.data ? [defaultCategory.data.category] : []),
        ...(categories.data?.categories.map((item) => item.category) ?? []),
      ]),
    ],
    [categories.data, defaultCategory.data],
  );
  const awaitingReview = intakeAwaitingAssistantReview(
    (state === "all" ? clips.data?.items : categoryClips.data?.items) ?? [],
  );
  const clipItems = (clips.data?.items ?? []).filter(
    (clip) =>
      (origin === "all" || intakeOrigin(clip.original_snapshot) === origin) &&
      (!needle || `${clip.title}\n${clip.body}`.toLowerCase().includes(needle)),
  );
  const selectedDiscarded = clipItems.filter(
    (clip) => clip.state === "discarded" && selectedIds.has(clip.id),
  );
  const discardedCount = clipItems.filter((clip) => clip.state === "discarded").length;
  const deleteSelection: TableSelection<IntakeClip> | undefined =
    canWrite && discardedCount > 0
      ? {
          selected: selectedIds,
          onChange: setSelectedIds,
          canSelect: (clip) => clip.state === "discarded",
          rowLabel: (clip) => t("intake.selectDiscarded", { title: clip.title }),
          allLabel: t("intake.deleteSelectedObject", { count: discardedCount }),
          bar:
            selectedDiscarded.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                data-testid="intake-delete-bulk-bar"
              >
                <span className="me-auto font-medium">
                  {t("intake.deleteSelectedObject", { count: selectedDiscarded.length })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteTargets(selectedDiscarded)}
                  data-testid="intake-delete-selected"
                >
                  {t("intake.deleteSelected", { count: selectedDiscarded.length })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  data-testid="intake-delete-clear-selection"
                >
                  {t("intake.clearDeletionSelection")}
                </Button>
              </div>
            ) : undefined,
        }
      : undefined;
  const loadedCategoryCounts = new Map(
    [...rowsByGroup(clipItems, (clip) => clip.category || UNCATEGORIZED)].map(
      ([key, members]) => [key, members.length] as const,
    ),
  );
  const categoryUsage = categoryValues
    .map((item) => ({
      category: item,
      count:
        categories.data?.categories.find((entry) => entry.category === item)?.counts?.intake ?? 0,
    }))
    .filter((entry) => entry.count > 0 || entry.category === defaultCategory.data?.category);
  const write = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await invalidateIntake(queryClient);
    },
    onError: (error) =>
      toast.error(
        t(
          error instanceof ApiError && error.status === 409
            ? "intake.proposal.confirmConflict"
            : "common.actionFailed",
        ),
      ),
  });
  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="intake-page"
        header={<PageHeader title={t("nav.inbox")} />}
      >
        <ForbiddenState />
      </Page>
    );
  const loading =
    categories.isPending ||
    defaultCategory.isPending ||
    clips.isPending ||
    (state !== "all" && categoryClips.isPending);
  const failed = Boolean(
    categories.error ||
      defaultCategory.error ||
      clips.error ||
      (state !== "all" && categoryClips.error),
  );
  const menuItems: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("intake.reviewChat"),
            href: absolute(chatNewHref({ prompt: intakeChatPrompt(effectiveCategory ?? "", t) })),
            testId: "intake-review-chat",
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: t("intake.chooseDefault"),
            onSelect: () => setSettingDefaultCategory(true),
            testId: "intake-category-default",
          },
        ]
      : []),
  ];
  const untouched = category === null && state === "all" && origin === "all" && !needle;
  const onboarding =
    !loading &&
    !failed &&
    untouched &&
    clipItems.length === 0 &&
    (categories.data?.categories ?? []).every((entry) => !entry.counts?.intake);
  const addButton = (testId: string) =>
    canWrite ? (
      <Button onClick={() => setAddingNote(true)} data-testid={testId}>
        {t("intake.add")}
      </Button>
    ) : undefined;
  const clipColumns = (() => {
    const column = tableColumns<IntakeClip>({ t, dateTime });
    return [
      column.custom(
        "title",
        (clip) => clip.title,
        t("knowledge.column.name"),
        (clip) => (
          <span className="flex min-w-0 items-center gap-3">
            <IntakeOriginIcon snapshot={clip.original_snapshot} tile="md" />
            <span className="truncate font-medium">{clip.title}</span>
          </span>
        ),
        { sortable: true, width: "w-[30%]" },
      ),
      column.custom(
        "origin",
        (clip) => intakeOrigin(clip.original_snapshot),
        t("intake.origin"),
        (clip) => (
          <Chip testId={`intake-origin-${clip.id}`}>
            <IntakeOriginIcon snapshot={clip.original_snapshot} size="size-3" />
            {intakeOriginLabel(clip.original_snapshot, t)}
          </Chip>
        ),
        { width: "w-[12%]" },
      ),
      column.custom(
        "category",
        (clip) => clip.category,
        t("intake.category"),
        (clip) => humanizeCategory(clip.category, t("catalog.categoryOther")),
        { sortable: true, width: "w-[15%]" },
      ),
      column.custom(
        "state",
        (clip) => clip.state,
        t("resource.field.status"),
        (clip) => <StatusBadge state={clip.state} label={t(intakeStateLabelKey(clip.state))} />,
        { width: "w-[15%]" },
      ),
      column.date(
        "captured_at",
        (clip) => clip.original_snapshot.captured_at,
        t("resource.field.createdAt"),
        { width: "w-[18%]" },
      ),
    ] satisfies CockpitColumn<IntakeClip>[];
  })();
  return (
    <Page
      kind="list"
      surface="collection"
      scroll="page"
      testId="intake-page"
      header={
        <PageHeader
          title={t("nav.inbox")}
          action={onboarding ? undefined : addButton("intake-add")}
          menu={
            menuItems.length > 0 ? (
              <ActionMenu alwaysMenu testId="intake-page-actions" items={menuItems} />
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-6 py-4">
        {canWrite ? (
          <IntakeNoteDialog
            categories={categoryValues}
            initialCategory={effectiveCategory ?? defaultCategory.data?.category}
            open={addingNote}
            onOpenChange={setAddingNote}
            onCreated={(clip) => {
              setAddingNote(false);
              void navigate({ to: recordHref("intake", clip.id) });
            }}
          />
        ) : null}
        <IntakeDefaultCategoryDialog
          category={defaultCategory.data?.category}
          initialCategory={effectiveCategory}
          categories={categoryValues}
          open={settingDefaultCategory}
          onOpenChange={setSettingDefaultCategory}
          onSave={(next) =>
            write.mutate(() => setIntakeDefaultCategory(next), {
              onSuccess: () => {
                setCategory(next);
                setSettingDefaultCategory(false);
              },
            })
          }
        />
        <ConfirmDialog
          open={deleteTargets.length > 0}
          onOpenChange={(next) => {
            if (!next) setDeleteTargets([]);
          }}
          object={
            deleteTargets.length === 1
              ? (deleteTargets[0]?.title ?? "")
              : t("intake.deleteSelectedObject", { count: deleteTargets.length })
          }
          verb={t("intake.delete")}
          consequence={t(
            deleteTargets.length === 1
              ? "intake.deleteConsequence"
              : "intake.deleteSelectedConsequence",
          )}
          destructive
          pending={deletePending}
          onConfirm={async () => {
            setDeletePending(true);
            const failedIds = new Set<string>();
            let conflict = false;
            let deleted = 0;
            try {
              for (const target of deleteTargets) {
                try {
                  await deleteDiscardedIntakeClip(target.id, target.version);
                  deleted += 1;
                } catch (error) {
                  failedIds.add(target.id);
                  if (error instanceof ApiError && error.status === 409) conflict = true;
                }
              }
              await invalidateIntake(queryClient);
              setSelectedIds(failedIds);
              setDeleteTargets([]);
              if (deleted > 0)
                toast.success(
                  t(deleted === 1 ? "intake.deleteSuccess" : "intake.deleteSelectedSuccess"),
                );
              if (failedIds.size > 0)
                toast.error(t(conflict ? "intake.deleteConflict" : "common.actionFailed"));
            } finally {
              setDeletePending(false);
            }
          }}
          testId="intake-delete-dialog"
        />
        {loading ? <DataState state="loading" testId="intake-loading" /> : null}
        {failed ? (
          <DataState
            state="error"
            line={t("intake.loadFailed")}
            onRetry={() => void invalidateIntake(queryClient)}
            testId="intake-error"
          />
        ) : null}
        {onboarding ? (
          <IntakeOnboarding {...(canWrite ? { onAddNote: () => setAddingNote(true) } : {})} />
        ) : null}
        {!loading && !failed && !onboarding ? (
          <>
            <SummaryLine
              text={
                <SummaryParts
                  parts={[
                    t(clipItems.length === 1 ? "intake.summary.one" : "intake.summary.other", {
                      count: clipItems.length,
                    }),
                    awaitingReview > 0 ? (
                      <button
                        type="button"
                        className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                        onClick={() => setOrigin("session")}
                        data-testid="intake-awaiting-review"
                      >
                        {t(
                          awaitingReview === 1
                            ? "intake.awaitingReview.one"
                            : "intake.awaitingReview.other",
                          { count: awaitingReview },
                        )}
                      </button>
                    ) : null,
                    <CatalogCategories key="categories" kind="intake" />,
                  ]}
                />
              }
              help={t("intake.explanation")}
              testId="intake-summary"
            />
            <DataTable<IntakeClip>
              columns={clipColumns}
              data={clipItems}
              groupingTabs={
                <>
                  <GroupingTabs
                    label={t("common.groupBy")}
                    value={groupMode}
                    onChange={setGroupMode}
                    options={[
                      { value: "all", label: t("common.all") },
                      { value: "category", label: t("intake.category") },
                      { value: "state", label: t("resource.field.status") },
                      { value: "origin", label: t("intake.origin") },
                    ]}
                    testId="intake-grouping"
                  />
                  <CatalogCategoryChips
                    usage={categoryUsage}
                    value={
                      category === "all"
                        ? "all"
                        : (category ?? defaultCategory.data?.category ?? "all")
                    }
                    onChange={(value) => setCategory(value === "all" ? "all" : value)}
                    testId="intake-category-chips"
                  />
                </>
              }
              grouping={
                groupMode === "all"
                  ? undefined
                  : groupMode === "category"
                    ? catalogCategoryGrouping<IntakeClip>({
                        getCategory: (clip) => clip.category || UNCATEGORIZED,
                        otherLabel: t("catalog.categoryOther"),
                        counts: loadedCategoryCounts,
                        needsAttention: intakeNeedsAssistantReview,
                      })
                    : {
                        getKey: (clip) =>
                          groupMode === "state"
                            ? t(intakeStateLabelKey(clip.state))
                            : t(intakeOriginLabelKey(intakeOrigin(clip.original_snapshot))),
                      }
              }
              getRowId={(clip) => clip.id}
              selection={deleteSelection}
              rowActions={
                canWrite && discardedCount > 0
                  ? (clip) =>
                      clip.state === "discarded" ? (
                        <ActionMenu
                          alwaysMenu
                          size="sm"
                          items={[
                            {
                              label: t("intake.delete"),
                              destructive: true,
                              onSelect: () => setDeleteTargets([clip]),
                              testId: `intake-delete-${clip.id}`,
                            },
                          ]}
                        />
                      ) : null
                  : undefined
              }
              toolbar={
                <>
                  <FilterBar
                    search={{
                      value: search,
                      onChange: setSearch,
                      placeholder: t("intake.search"),
                      testId: "intake-search",
                    }}
                    selects={
                      [
                        {
                          value:
                            category === "all"
                              ? "all"
                              : (category ?? defaultCategory.data?.category ?? "all"),
                          onChange: (value) => setCategory(value === "all" ? "all" : value),
                          label: t("intake.category"),
                          testId: "intake-category",
                          options: [
                            { value: "all", label: t("intake.allCategories") },
                            ...categoryValues.map((item) => ({
                              value: item,
                              label: humanizeCategory(item, t("catalog.categoryOther")),
                            })),
                          ],
                        },
                        {
                          value: state,
                          onChange: (value) => setState(value as typeof state),
                          label: t("intake.stateFilter"),
                          testId: "intake-state",
                          options: [
                            { value: "all", label: t("intake.state.all") },
                            ...INTAKE_STATES.map((item) => ({
                              value: item,
                              label: t(intakeStateLabelKey(item)),
                            })),
                          ],
                        },
                        {
                          value: origin,
                          onChange: (value) => setOrigin(value as typeof origin),
                          label: t("intake.originFilter"),
                          testId: "intake-origin",
                          options: [
                            { value: "all", label: t("intake.origin.all") },
                            ...INTAKE_ORIGINS.map((item) => ({
                              value: item,
                              label: t(intakeOriginLabelKey(item)),
                            })),
                          ],
                        },
                      ] satisfies FilterSelect[]
                    }
                    reset={{
                      label: t("catalog.clearFilters"),
                      onClick: () => {
                        setSearch("");
                        setCategory(null);
                        setState("all");
                        setOrigin("all");
                      },
                    }}
                  />
                  {origin === "all" ? null : (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={t("intake.originChipClear")}
                      data-testid="intake-origin-filter-chip"
                      onClick={() => setOrigin("all")}
                    >
                      {t("intake.originChip", { origin: t(intakeOriginLabelKey(origin)) })}
                      <X aria-hidden="true" />
                    </Button>
                  )}
                </>
              }
              pending={false}
              emptyState={{
                zero: {
                  title: t("intake.empty"),
                  ...(canWrite ? { action: addButton("intake-empty-add") } : {}),
                },
                filtered: {
                  title: t("resource.noMatches"),
                  description: t("resource.broaderSearch"),
                  resetLabel: t("catalog.clearFilters"),
                  onReset: () => {
                    setSearch("");
                    setCategory(null);
                    setState("all");
                    setOrigin("all");
                  },
                },
              }}
              hasActiveFilters={!untouched}
              sorting={sorting}
              onSortingChange={setSorting}
              onOpen={(clip) => void navigate({ to: recordHref("intake", clip.id) })}
              rowHref={(clip) => recordHref("intake", clip.id)}
              rowLabel={(clip) => clip.title}
              columnsLabel={t("catalog.columns")}
              actionsLabel={t("common.actions")}
              collectionId="intake-items"
            />
          </>
        ) : null}
      </div>
    </Page>
  );
}
