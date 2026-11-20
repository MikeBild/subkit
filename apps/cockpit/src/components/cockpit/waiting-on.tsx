import { UserRoundCheck } from "lucide-react";
import { useWaitingOn } from "@/app/use-attention";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { waitingOnLine } from "@/pages/overview-model";

export function WaitingOnLine({
  name,
  className,
  testId,
}: {
  name: string;
  className?: string;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <span
      className={cn("inline-flex min-w-0 items-start gap-1.5 text-sm text-foreground", className)}
      data-testid={testId}
    >
      <UserRoundCheck
        aria-hidden="true"
        className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="[overflow-wrap:anywhere]">{waitingOnLine(name, t)}</span>
    </span>
  );
}

export function WaitingOnApprover({
  subjectId,
  permissions,
  className,
  testId,
}: {
  subjectId: string | null | undefined;
  permissions: readonly string[];
  className?: string;
  testId: string;
}) {
  const name = useWaitingOn(subjectId, permissions);
  return name ? <WaitingOnLine name={name} className={className} testId={testId} /> : null;
}
