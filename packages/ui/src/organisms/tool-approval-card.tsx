import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Pill } from "@ui/atoms/pill";
import { Spinner } from "@ui/atoms/spinner";
import { useI18n } from "@ui/lib/ui-context";
import { type LucideIcon, Quote, Wrench } from "lucide-react";
import type { ReactNode } from "react";

export type ToolApprovalStatus = "pending" | "allowed" | "denied";

export type ToolApprovalRow = [label: string, value: string, testId?: string];

export function ToolApprovalCard({
  rows = [],
  quote,
  status = "pending",
  onDecision,
  title,
  icon = Wrench,
  children,
  labels,
  busy = false,
  approveDisabled = false,
  declineDisabled = false,
  showPending = true,
  actions,
  footnote,
  testId,
}: {
  rows?: ToolApprovalRow[] | undefined;
  quote?: string | undefined;
  status?: ToolApprovalStatus | undefined;
  onDecision: (allow: boolean) => void;
  title?: ReactNode;
  icon?: LucideIcon | undefined;
  children?: ReactNode;
  labels?: { approve?: ReactNode; decline?: ReactNode; pending?: ReactNode } | undefined;
  busy?: boolean | undefined;
  approveDisabled?: boolean | undefined;
  declineDisabled?: boolean | undefined;
  showPending?: boolean | undefined;
  actions?: ReactNode;
  footnote?: ReactNode;
  testId?: string | undefined;
}) {
  const { t } = useI18n();
  const x = t.approval;
  const id = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);
  const decisions =
    status === "pending" ? (
      <>
        <Button
          size="sm"
          disabled={busy || approveDisabled}
          onClick={() => onDecision(true)}
          data-testid={id("approve")}
        >
          {busy && <Spinner aria-hidden="true" aria-label={undefined} />}
          {labels?.approve ?? x.allowOnce}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || declineDisabled}
          onClick={() => onDecision(false)}
          data-testid={id("decline")}
        >
          {labels?.decline ?? x.deny}
        </Button>
        {showPending && (
          <span className="text-xs text-muted-foreground" data-testid={id("pending")}>
            {labels?.pending ?? x.pending}
          </span>
        )}
      </>
    ) : (
      <Pill tone={status === "allowed" ? "success" : "danger"}>
        {status === "allowed" ? x.allowed : x.denied}
      </Pill>
    );
  const note = footnote === undefined ? x.scopeNote : footnote;
  return (
    <div>
      <div className="rounded-xl border bg-card p-6" data-testid={testId}>
        <div className="flex items-center gap-3">
          <IconTile icon={icon} size="sm" />
          <div className="flex items-center gap-1 text-sm font-semibold">{title ?? x.wants}</div>
        </div>
        {(rows.length > 0 || quote || children) && (
          <div className="mt-3 grid gap-3">
            {rows.length > 0 && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {rows.map(([k, v, rowTestId]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words" data-testid={rowTestId}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {quote && (
              <p className="flex items-start gap-2 text-sm">
                <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{x.because(quote)}</span>
              </p>
            )}
            {children}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">{actions ?? decisions}</div>
      </div>
      {note !== null && note !== false && (
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
