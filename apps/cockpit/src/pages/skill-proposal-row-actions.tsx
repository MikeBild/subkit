import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { approveSkillCandidate, rejectSkillCandidate, type SkillCandidate } from "@/api/decisions";
import { Button, ConfirmDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { mayApproveProposal } from "@/pages/skill-proposal-model";

export function SkillProposalRowActions({
  candidate,
  permissions,
  onDecided,
}: {
  candidate: Pick<SkillCandidate, "id" | "title" | "reviewable" | "review_digest">;
  permissions: readonly string[];
  onDecided(): void;
}) {
  const { t } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const accept = useMutation({
    mutationFn: () => approveSkillCandidate(candidate.id, candidate.review_digest ?? ""),
    onSuccess: () => {
      toast.success(t("skills.accepted", { name: candidate.title }));
      onDecided();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const reject = useMutation({
    mutationFn: () => rejectSkillCandidate(candidate.id, t("skills.rejectReason")),
    onSuccess: () => {
      toast.success(t("skills.rejected", { name: candidate.title }));
      setRejecting(false);
      onDecided();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  if (!permissions.includes("skill:write") || !candidate.reviewable || !candidate.review_digest)
    return null;
  return (
    <>
      {mayApproveProposal(permissions) ? (
        <Button
          variant="outline"
          size="sm"
          pending={accept.isPending}
          disabled={reject.isPending}
          onClick={() => accept.mutate()}
          data-testid={`skill-proposal-row-accept-${candidate.id}`}
        >
          {t("skills.accept")}
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={accept.isPending || reject.isPending}
        onClick={() => setRejecting(true)}
        data-testid={`skill-proposal-row-reject-${candidate.id}`}
      >
        {t("skills.reject")}
      </Button>
      <ConfirmDialog
        open={rejecting}
        onOpenChange={(open) => !reject.isPending && setRejecting(open)}
        object={t("skills.proposalObject")}
        verb={t("skills.reject")}
        consequence={t("skills.rejectConsequence", { name: candidate.title })}
        destructive
        pending={reject.isPending}
        onConfirm={() => reject.mutateAsync().then(() => undefined)}
        testId={`skill-proposal-row-reject-confirm-${candidate.id}`}
      />
    </>
  );
}
