import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { approveSkillCandidate, rejectSkillCandidate, type SkillCandidate } from "@/api/decisions";
import { absolute, recordHref } from "@/app/links";
import { useNameIndex } from "@/app/use-decisions";
import { ORIGIN_LABEL } from "@/components/cockpit/decision-card";
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
import { useI18n } from "@/lib/i18n-context";
import { skillTargetName } from "@/lib/name-index";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { skillDecision } from "@/pages/decisions-model";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";
import { skillScopeKey } from "@/pages/skills-model";

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
  const canWrite = permissions.includes("skill:write");
  const canAdopt = canWrite && permissions.includes("skill:activate");
  const names = useNameIndex(permissions, Boolean(candidate));
  const [rejecting, setRejecting] = useState(false);
  const hidden = t("tool.referenceHiddenInline");

  const accept = useMutation({
    mutationFn: (target: SkillCandidate) =>
      approveSkillCandidate(target.id, target.review_digest ?? ""),
    onSuccess: (_result, target) => {
      toast.success(t("skills.accepted", { name: target.title }));
      onDecided();
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const reject = useMutation({
    mutationFn: (target: SkillCandidate) =>
      rejectSkillCandidate(target.id, t("skills.rejectReason")),
    onSuccess: (_result, target) => {
      toast.success(t("skills.rejected", { name: target.title }));
      setRejecting(false);
      onDecided();
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

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
  const facts: Fact[] =
    candidate && item
      ? [
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
          candidate && decidable && canWrite ? (
            <span className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setRejecting(true)}
                data-testid="skill-proposal-reject"
              >
                {t("skills.reject")}
              </Button>
              {canAdopt ? (
                <Button
                  pending={accept.isPending}
                  onClick={() => accept.mutate(candidate)}
                  data-testid="skill-proposal-accept"
                >
                  {t("skills.accept")}
                </Button>
              ) : null}
            </span>
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
      {candidate ? (
        <ConfirmDialog
          open={rejecting}
          onOpenChange={(open) => !reject.isPending && setRejecting(open)}
          object={t("skills.proposalObject")}
          verb={t("skills.reject")}
          consequence={t("skills.rejectConsequence", {
            name: hideTechnicalIdentifiers(candidate.title, hidden),
          })}
          destructive
          pending={reject.isPending}
          onConfirm={() => reject.mutateAsync(candidate).then(() => undefined)}
          testId="skill-proposal-reject-confirm"
        />
      ) : null}
    </>
  );
}
