import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { approveSkillCandidate, rejectSkillCandidate, type SkillCandidate } from "@/api/decisions";
import { Button, ConfirmDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { mayApproveProposal } from "@/pages/skill-proposal-model";

type ProposalFacts = Pick<SkillCandidate, "id" | "title" | "reviewable" | "review_digest">;

export function SkillProposalActions({
  candidate,
  permissions,
  onDecided,
  placement,
}: {
  candidate: ProposalFacts;
  permissions: readonly string[];
  onDecided(): void;
  placement: "row" | "sheet";
}) {
  const { t } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const name = hideTechnicalIdentifiers(candidate.title, t("tool.referenceHiddenInline"));
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
  const row = placement === "row";
  const testId = (action: "accept" | "reject") =>
    row ? `skill-proposal-row-${action}-${candidate.id}` : `skill-proposal-${action}`;
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="outline"
        size={row ? "sm" : "default"}
        disabled={accept.isPending || reject.isPending}
        onClick={() => setRejecting(true)}
        data-testid={testId("reject")}
      >
        {t("skills.reject")}
      </Button>
      {mayApproveProposal(permissions) ? (
        <Button
          variant={row ? "outline" : "default"}
          size={row ? "sm" : "default"}
          pending={accept.isPending}
          disabled={reject.isPending}
          onClick={() => accept.mutate()}
          data-testid={testId("accept")}
        >
          {t("skills.accept")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={rejecting}
        onOpenChange={(open) => !reject.isPending && setRejecting(open)}
        object={t("skills.proposalObject")}
        verb={t("skills.reject")}
        consequence={t("skills.rejectConsequence", { name })}
        destructive
        pending={reject.isPending}
        onConfirm={() => reject.mutateAsync().then(() => undefined)}
        testId={
          row
            ? `skill-proposal-row-reject-confirm-${candidate.id}`
            : "skill-proposal-reject-confirm"
        }
      />
    </span>
  );
}

export function SkillProposalRowActions(props: {
  candidate: ProposalFacts;
  permissions: readonly string[];
  onDecided(): void;
}) {
  return <SkillProposalActions {...props} placement="row" />;
}
