import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { approveSkillCandidate, rejectSkillCandidate, type SkillCandidate } from "@/api/decisions";
import { useActorDirectory } from "@/app/actor-directory";
import { actorLabel } from "@/app/actor-directory-model";
import { absolute, recordHref } from "@/app/links";
import { useNameIndex } from "@/app/use-decisions";
import {
  Button,
  ConfirmDialog,
  type Fact,
  FactList,
  FilePreview,
  RecordSheet,
  Section,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { skillTargetName } from "@/lib/name-index";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { ORIGIN_LABEL, skillDecision } from "@/pages/decisions-model";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";
import { mayApproveProposal } from "@/pages/skill-proposal-model";
import { skillScopeKey } from "@/pages/skills-model";

type ProposalFacts = Pick<SkillCandidate, "id" | "title" | "reviewable" | "review_digest">;

export function SkillProposalActions({
  candidate,
  permissions,
  onDecided,
}: {
  candidate: ProposalFacts;
  permissions: readonly string[];
  onDecided(): void;
}) {
  const { t } = useI18n();
  const [discarding, setDiscarding] = useState(false);
  const name = hideTechnicalIdentifiers(candidate.title, t("tool.referenceHiddenInline"));
  const accept = useMutation({
    mutationFn: () => approveSkillCandidate(candidate.id, candidate.review_digest ?? ""),
    onSuccess: () => {
      toast.success(t("skills.accepted", { name: candidate.title }));
      onDecided();
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });
  const discard = useMutation({
    mutationFn: () => rejectSkillCandidate(candidate.id, t("skills.rejectReason")),
    onSuccess: () => {
      toast.success(t("skills.rejected", { name: candidate.title }));
      setDiscarding(false);
      onDecided();
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });
  if (!permissions.includes("skill:write") || !candidate.reviewable || !candidate.review_digest)
    return null;
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        disabled={accept.isPending || discard.isPending}
        onClick={() => setDiscarding(true)}
        data-testid="skill-proposal-reject"
      >
        {t("skills.reject")}
      </Button>
      {mayApproveProposal(permissions) ? (
        <Button
          pending={accept.isPending}
          disabled={discard.isPending}
          onClick={() => accept.mutate()}
          data-testid="skill-proposal-accept"
        >
          {t("skills.accept")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={discarding}
        onOpenChange={(open) => !discard.isPending && setDiscarding(open)}
        object={t("skills.proposalObject")}
        verb={t("skills.reject")}
        consequence={t("skills.rejectConsequence", { name })}
        destructive
        pending={discard.isPending}
        onConfirm={() => discard.mutateAsync().then(() => undefined)}
        testId="skill-proposal-reject-confirm"
      />
    </span>
  );
}

export function SkillProposalSheet({
  candidate,
  permissions,
  onClose,
  onDecided,
}: {
  candidate: SkillCandidate | null;
  permissions: readonly string[];
  onClose: () => void;
  onDecided: () => void;
}) {
  const { t } = useI18n();
  const names = useNameIndex(permissions, Boolean(candidate));
  const directory = useActorDirectory(Boolean(candidate));
  const hidden = t("tool.referenceHiddenInline");

  const item = candidate ? skillDecision(candidate, skillTargetName(names, candidate)) : null;
  const detail = item?.detail.kind === "skill" ? item.detail : null;
  const targetHref =
    candidate && item?.target
      ? candidate.scope === "workflow" && candidate.workflow_id
        ? recordHref("workflows", candidate.workflow_id)
        : candidate.scope === "connector" && candidate.connector_id
          ? recordHref("connectors", candidate.connector_id)
          : null
      : null;
  const author = candidate ? actorLabel(directory, candidate.proposed_by, t) : null;
  const facts: Fact[] =
    candidate && item
      ? [
          ...(author ? [{ label: t("proposal.author"), value: author }] : []),
          {
            label: t("skills.proposal.appliesTo"),
            value: targetHref ? (
              <a
                href={absolute(targetHref)}
                className="underline underline-offset-2"
                data-testid="skill-proposal-target"
              >
                {item.target}
              </a>
            ) : (
              (item.target ?? t(skillScopeKey(candidate.scope)))
            ),
          },
          { label: t("skills.proposal.reason"), value: t(ORIGIN_LABEL[item.origin]) },
        ]
      : [];
  const lists = detail
    ? [
        { label: t("decisions.detail.examples"), items: detail.sections.examples, id: "examples" },
        {
          label: t("decisions.detail.bestPractices"),
          items: detail.sections.bestPractices,
          id: "best-practices",
        },
        { label: t("decisions.detail.pitfalls"), items: detail.sections.pitfalls, id: "pitfalls" },
        { label: t("decisions.detail.docRefs"), items: detail.sections.docRefs, id: "doc-refs" },
      ].filter((list) => list.items.length > 0)
    : [];
  const decidable = candidate?.reviewable === true && Boolean(candidate.review_digest);

  return (
    <>
      <RecordSheet
        open={Boolean(candidate)}
        onOpenChange={(open) => !open && onClose()}
        title={candidate ? hideTechnicalIdentifiers(candidate.title, hidden) : ""}
        titleTestId="skill-proposal-title"
        badge={<StatusBadge state="proposed" label={t("skills.state.proposed")} />}
        action={
          candidate && decidable ? (
            <SkillProposalActions
              candidate={candidate}
              permissions={permissions}
              onDecided={() => {
                onDecided();
                onClose();
              }}
            />
          ) : undefined
        }
        testId="skill-proposal"
        closeTestId="skill-proposal-close"
      >
        {candidate && detail ? (
          <>
            <FactList items={facts} testId="skill-proposal-facts" />
            <Section label={t("skills.editor.body")} testId="skill-proposal-body">
              <FilePreview
                name=""
                mimeType="text/markdown"
                text={documentUnderTitle(
                  hideTechnicalIdentifiers(detail.body, hidden),
                  candidate.title,
                )}
                testId="skill-proposal-preview"
              />
            </Section>
            {lists.map((list) => (
              <Section key={list.id} label={list.label} testId={`skill-proposal-${list.id}`}>
                <ul className="grid list-disc gap-1 pl-5 text-sm">
                  {list.items.map((entry, index) => (
                    <li key={`${entry}-${index}`} className="break-words">
                      {hideTechnicalIdentifiers(entry, hidden)}
                    </li>
                  ))}
                </ul>
              </Section>
            ))}
          </>
        ) : null}
      </RecordSheet>
    </>
  );
}
