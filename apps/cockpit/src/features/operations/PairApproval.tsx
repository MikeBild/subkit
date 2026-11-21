import { IconTile } from "@ui/atoms/icon-tile";
import { Pill } from "@ui/atoms/pill";
import { cn } from "@ui/lib/utils";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { UserRound, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { PairLinkRow, PairLinkTarget } from "./pair-link-model";
import { type PairAction, type PairApproval, type PairFailure, pairView } from "./pair-model";

const ACTION_KEY: Record<PairAction, TranslationKey> = {
  approve: "ops.pair.approve",
  decline: "ops.pair.decline",
  withdraw: "ops.pair.withdraw",
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function Slot({ name, filled, testId }: { name: string | null; filled: boolean; testId: string }) {
  const { t } = useI18n();
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2"
      data-testid={testId}
      data-filled={filled}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          filled ? "bg-success/15 text-success-ink" : "border border-dashed text-muted-foreground",
        )}
      >
        {filled && name ? initials(name) : <UserRound className="size-4" />}
      </span>
      <span className="min-w-0 truncate text-sm">
        {name ?? <span className="text-muted-foreground">{t("ops.pair.open")}</span>}
      </span>
    </div>
  );
}

export function PairApprovalCard({
  pair,
  viewerId,
  now,
  pending,
  failure,
  onAction,
  linked = false,
  testId = "pair-approval",
}: {
  pair: PairApproval;
  viewerId: string;
  now: number;
  pending: PairAction | null;
  failure: PairFailure | null;
  onAction: (action: PairAction) => void;
  linked?: boolean;
  testId?: string;
}) {
  const { t, dateTime } = useI18n();
  const view = pairView(pair, viewerId, now);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!linked) return;
    root.current?.scrollIntoView({ block: "nearest" });
    root.current?.focus({ preventScroll: true });
  }, [linked]);
  return (
    <div
      ref={root}
      tabIndex={linked ? -1 : undefined}
      className="flex flex-col gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid={testId}
      data-state={view.state}
      data-linked={linked || undefined}
    >
      <div className="flex items-center gap-3">
        <IconTile icon={Users} size="sm" />
        <span className="min-w-0 flex-1 text-sm font-medium">{t("ops.pair.title")}</span>
        <Pill tone={view.tone}>{t(`ops.pair.state.${view.state}` as TranslationKey)}</Pill>
      </div>
      <div className="flex items-center gap-3">
        <Slot name={view.slots[0].name} filled testId={`${testId}-first`} />
        <Slot name={view.slots[1].name} filled={view.slots[1].filled} testId={`${testId}-second`} />
      </div>
      {view.open ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-expires`}>
          {t("ops.pair.expires", { time: dateTime(pair.expires_at) })}
        </p>
      ) : null}
      {view.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {view.actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "approve" ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => onAction(action)}
              data-testid={`${testId}-${action}`}
            >
              {t(ACTION_KEY[action])}
            </Button>
          ))}
        </div>
      ) : null}
      {failure ? (
        <ErrorNotice
          kind={failure}
          title={t(`ops.pair.failure.${failure}` as TranslationKey)}
          testId={`${testId}-failure`}
        />
      ) : null}
    </div>
  );
}

function linkRow(
  row: PairLinkRow,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
): [string, string] {
  if (row.key === "reason") return [t("ops.pair.link.reason"), t(`ops.pair.stale.${row.reason}`)];
  return [t("ops.pair.link.at"), dateTime(row.at)];
}

export function PairLinkNotice({
  target,
  testId = "pair-link",
}: {
  target: PairLinkTarget;
  testId?: string;
}) {
  const { t, dateTime } = useI18n();
  if (target.kind === "closed")
    return (
      <ErrorNotice
        kind="pair_request_closed"
        tone="warning"
        title={t("ops.pair.link.closed")}
        body={t(`ops.pair.state.${target.state}` as TranslationKey)}
        rows={target.rows.map((row) => linkRow(row, t, dateTime))}
        testId={`${testId}-closed`}
      />
    );
  if (target.kind === "missing")
    return (
      <ErrorNotice
        kind="pair_request_not_found"
        tone="warning"
        title={t("ops.pair.link.missing")}
        body={t("ops.pair.link.missingBody")}
        rows={[[t("ops.pair.link.request"), target.id]]}
        testId={`${testId}-missing`}
      />
    );
  return null;
}
