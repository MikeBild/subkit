import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import type { IntakeProposal } from "@/api/intake";
import { absolute, recordHref } from "@/app/links";
import {
  Button,
  Chip,
  CollapsibleSection,
  ConfirmDialog,
  FilePreview,
  Section,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { FocusedDiff } from "@/features/workflows";
import { useI18n } from "@/lib/i18n-context";
import {
  changedSkillLine,
  isSkillTarget,
  mayConfirmIntakeProposal,
  newSkillLine,
  type ReferencedSkill,
  skillBodyChange,
  skillConventionsView,
  skillTargetIds,
} from "./model/intake-model";

export async function loadSkillBinding(created: {
  connector_id?: string;
  workflow_id?: string;
}): Promise<{ name: string }> {
  if (created.connector_id) {
    const connector = await apiCall("get", "/v1/connectors/{id}", {
      path: { id: created.connector_id },
    });
    return { name: connector.display_name };
  }
  const workflow = await apiCall("get", "/v1/workflows/{id}", {
    path: { id: created.workflow_id ?? "" },
  });
  return { name: workflow.name };
}

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
      apiCall("get", "/v1/knowledge-sources/{id}", { path: { id: knowledgeId ?? "" } }),
    enabled: Boolean(knowledgeId),
  });
  const skillIds = skillTarget ? skillTargetIds(skillTarget) : [];
  const skillQueries = useQueries({
    queries: skillIds.map((id) => ({
      queryKey: ["skill", "intake-target", id],
      queryFn: () => apiCall("get", "/v1/skills/{id}", { path: { id } }),
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
    queryFn: () => loadSkillBinding(created ?? {}),
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
