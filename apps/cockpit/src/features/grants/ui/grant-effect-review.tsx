import { cn } from "@ui/lib/utils";
import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  KeyRound,
  type LucideIcon,
  PenLine,
  ShieldCheck,
  Trash2,
  TriangleExclamationPoint,
} from "lucide-react";
import type { ReactNode } from "react";
import { CollapsibleSection, chipClass, RowsSkeleton } from "@/components/cockpit/patterns";
import { ServiceChips, ServiceIcon } from "@/features/connectors";
import { type BoundaryGrowth, growthLine } from "@/features/grants/model/authority-growth";
import { mcpBoundaryOf, presentMcpBoundary } from "@/features/grants/model/authority-mcp";
import {
  CLASS_KEYS,
  presentRequestBoundary,
  type RequestBoundaryView,
} from "@/features/grants/model/authority-request";
import type {
  AuthorityReviewModel,
  ReviewGroup,
  ReviewRow,
} from "@/features/grants/model/authority-review-model";
import { presentStorageScope } from "@/features/grants/model/authority-storage";
import { effectLabel } from "@/features/grants/model/effect-label";
import { AUTHORITY_EFFECT_KEYS } from "@/features/grants/model/workflow-authorities";
import { useI18n } from "@/lib/i18n-context";

const ICONS: Record<ReviewRow["effect"], LucideIcon> = {
  read: BookOpen,
  write: PenLine,
  destructive: Trash2,
  unknown: CircleHelp,
};

const TONE = {
  read: "text-muted-foreground",
  write: "text-warning-ink",
  risky: "text-destructive",
} as const;

const CHIP = chipClass("md");

function Chevron() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
    />
  );
}

function RowDetails({ row, toolPinsCompared }: { row: ReviewRow; toolPinsCompared: boolean }) {
  const { t, tn, locale } = useI18n();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const effect = row.source;
  const request = effect.boundary ? presentRequestBoundary(effect.boundary, number) : null;
  const storage = effect.storage ? presentStorageScope(effect.storage, number) : null;
  const toolBoundary = mcpBoundaryOf(effect);
  const tool = toolBoundary ? presentMcpBoundary(toolBoundary, toolPinsCompared) : null;
  const classSentence = (name: string, rule: string) => {
    const key = CLASS_KEYS[rule];
    return key ? t(key, { name }) : t("authority.boundary.unknownRule", { name, rule });
  };
  return (
    <details className="group/details" data-testid={`authority-effect-details-${row.step_id}`}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 transition-transform group-open/details:rotate-90 motion-reduce:transition-none"
        />
        {t("authority.review.details")}
      </summary>
      <div className="flex flex-col gap-1 pb-2 pl-5 text-xs">
        {request && effect.boundary ? (
          <>
            <p className="break-all font-mono">{`${effect.boundary.method} ${request.target}`}</p>
            {row.placeholders.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {row.placeholders.map((entry) => (
                  <li key={entry.name}>
                    {entry.kind === "enum"
                      ? t("authority.review.placeholder.enum", {
                          name: entry.name,
                          values: entry.values.join(", "),
                        })
                      : entry.kind === "caller"
                        ? t("authority.review.placeholder.caller", { name: entry.name })
                        : classSentence(entry.name, entry.rule)}
                  </li>
                ))}
              </ul>
            )}
            {request.connectorQuery && (
              <p>{t(request.connectorQuery.key, request.connectorQuery.values)}</p>
            )}
            <p>{t(request.body.key, request.body.values)}</p>
            {request.paging &&
              ((effect.boundary as RequestBoundaryView).pagination?.location === "body" ? (
                <p>{t(request.paging.key, request.paging.values)}</p>
              ) : (
                <p>
                  {t("authority.review.paging", {
                    params: effect.boundary.pagination?.params.join(", ") ?? "",
                  })}
                </p>
              ))}
            <p>{tn("authority.boundary.calls", effect.boundary.max_calls)}</p>
            {request.declaredDestructive && <p>{t("authority.boundary.declaredDestructive")}</p>}
          </>
        ) : tool ? (
          <>
            <p className="break-all font-mono">{`${effect.operation} ${tool.target}`}</p>
            <p>{t(tool.fixed)}</p>
            {tool.variables.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {tool.variables.map((entry) => (
                  <li key={entry.values.name}>{t(entry.key, entry.values)}</li>
                ))}
              </ul>
            )}
            <p>{tn("authority.boundary.calls", tool.calls)}</p>
            <p className="break-all">
              {t("authority.mcp.descriptor", { digest: tool.descriptor })}
            </p>
          </>
        ) : storage && effect.storage ? (
          <>
            <p>{t("authority.storage.folder", { folder: effect.storage.key_prefix })}</p>
            <p className="break-all font-mono">{effect.storage.base_url}</p>
            <p>{t(storage.detail, storage.values)}</p>
          </>
        ) : (
          <>
            <p className="break-all font-mono">{`${effect.operation} ${effect.target ?? t("authority.unboundTarget")}`}</p>
            {effect.read_path && <p>{t("authority.readPath")}</p>}
          </>
        )}
        {row.risk !== "read" && <p>{t("authority.boundary.contentNotice")}</p>}
      </div>
    </details>
  );
}

function RowNotes({
  row,
  toolPinsCompared,
  toolNotesAbove,
}: {
  row: ReviewRow;
  toolPinsCompared: boolean;
  toolNotesAbove: boolean;
}) {
  const { t, tn } = useI18n();
  const boundary = row.source.boundary as RequestBoundaryView | undefined;
  const bodyPages =
    boundary?.pagination?.location === "body" ? boundary.pagination.max_requests : null;
  const connectorAdds =
    boundary?.connector_query !== undefined &&
    Object.keys(boundary.connector_query.fixed).length +
      boundary.connector_query.credential.length >
      0;
  const toolBoundary = mcpBoundaryOf(row.source);
  const tool =
    toolBoundary && !toolNotesAbove ? presentMcpBoundary(toolBoundary, toolPinsCompared) : null;
  if (!connectorAdds && bodyPages === null && !tool) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={`authority-effect-notes-${row.step_id}`}>
      {connectorAdds && <p>{t("authority.boundary.connectorAdds")}</p>}
      {bodyPages !== null && <p>{tn("authority.boundary.bodyPagingNote", bodyPages)}</p>}
      {tool && (
        <>
          <p>{t(tool.stated)}</p>
          <p className="text-muted-foreground">{t(tool.hint)}</p>
          {tool.unconfirmedRead && (
            <p
              className="text-warning-ink"
              data-testid={`authority-effect-unconfirmed-${row.step_id}`}
            >
              {t("authority.mcp.statedReadUnconfirmed")}
            </p>
          )}
          <p className="text-muted-foreground">{t("authority.mcp.pinned")}</p>
        </>
      )}
    </div>
  );
}

function EffectRow({
  row,
  toolPinsCompared,
  toolNotesAbove,
}: {
  row: ReviewRow;
  toolPinsCompared: boolean;
  toolNotesAbove: boolean;
}) {
  const { t } = useI18n();
  const Icon = ICONS[row.effect];
  const label = effectLabel(t, row.subject, row.step_id);
  return (
    <details
      open={row.open}
      className="group border-b last:border-b-0"
      data-testid={`authority-effect-row-${row.step_id}`}
      data-risk={row.risk}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-2 [&::-webkit-details-marker]:hidden">
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", TONE[row.risk])} />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {row.callStep && (
          <span className="text-xs text-muted-foreground">
            {t("authority.review.viaCall", { step: row.callStep })}
          </span>
        )}
        {(row.change === "added" || row.change === "widened") && (
          <span className={cn(CHIP, row.risk === "read" ? "text-primary" : TONE[row.risk])}>
            {t(
              row.change === "added"
                ? "authority.review.row.added"
                : "authority.review.row.widened",
            )}
          </span>
        )}
        <span className={cn(CHIP, TONE[row.risk])}>{t(AUTHORITY_EFFECT_KEYS[row.effect])}</span>
        {row.ceiling !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {row.previousCeiling !== null
              ? t("authority.review.ceilingChange", {
                  previous: row.previousCeiling,
                  count: row.ceiling,
                })
              : t("authority.review.ceiling", { count: row.ceiling })}
          </span>
        )}
        <Chevron />
      </summary>
      <div className="flex flex-col gap-1 pb-1 pl-6 text-sm">
        {row.unbound.length > 0 && (
          <p className="text-warning-ink" data-testid={`authority-effect-unbound-${row.step_id}`}>
            {t("authority.review.unbound", { names: row.unbound.join(", ") })}
          </p>
        )}
        <RowNotes row={row} toolPinsCompared={toolPinsCompared} toolNotesAbove={toolNotesAbove} />
        <RowDetails row={row} toolPinsCompared={toolPinsCompared} />
      </div>
    </details>
  );
}

function Group({
  group,
  toolPinsCompared,
  toolNotesAbove,
}: {
  group: ReviewGroup;
  toolPinsCompared: boolean;
  toolNotesAbove: boolean;
}) {
  const { t } = useI18n();
  return (
    <details
      open={group.open}
      className="group/group rounded-md border"
      data-testid="authority-effect-group"
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ServiceIcon service={group.service} />
        <span className="font-medium">{group.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {group.scope}
        </span>
        {group.counts.risky > 0 && (
          <span
            className={cn(CHIP, TONE.risky)}
          >{`${group.counts.risky} ${t("authority.review.tile.risky")}`}</span>
        )}
        {group.counts.write > 0 && (
          <span
            className={cn(CHIP, TONE.write)}
          >{`${group.counts.write} ${t("authority.review.tile.write")}`}</span>
        )}
        {group.counts.read > 0 && (
          <span
            className={cn(CHIP, TONE.read)}
          >{`${group.counts.read} ${t("authority.review.tile.read")}`}</span>
        )}
      </summary>
      <div className="px-3">
        {group.rows.map((row) => (
          <EffectRow
            key={row.key}
            row={row}
            toolPinsCompared={toolPinsCompared}
            toolNotesAbove={toolNotesAbove}
          />
        ))}
      </div>
    </details>
  );
}

function ToolNotes({
  model,
  toolPinsCompared,
}: {
  model: AuthorityReviewModel;
  toolPinsCompared: boolean;
}) {
  const { t } = useI18n();
  const tools = model.groups.flatMap((group) =>
    group.rows.flatMap((row) => {
      const boundary = mcpBoundaryOf(row.source);
      return boundary ? [{ row, tool: presentMcpBoundary(boundary, toolPinsCompared) }] : [];
    }),
  );
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="authority-tool-notes">
      {tools.map(({ row, tool }) => (
        <div
          key={row.key}
          className="flex flex-col gap-0.5"
          data-testid={`authority-tool-note-${row.step_id}`}
        >
          <p>
            <span className="font-medium">{effectLabel(t, row.subject, row.step_id)}</span>
            {" · "}
            {t(tool.stated)}
          </p>
          <p className="text-muted-foreground">{t(tool.hint)}</p>
          {tool.unconfirmedRead && (
            <p
              className="text-warning-ink"
              data-testid={`authority-effect-unconfirmed-${row.step_id}`}
            >
              {t("authority.mcp.statedReadUnconfirmed")}
            </p>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t("authority.mcp.pinned")}</p>
    </div>
  );
}

export function GrantEffectReview({
  model,
  growth,
  problems,
  loading,
  toolPinsCompared = false,
  compact = false,
  beforeDetails,
  children,
}: {
  toolPinsCompared?: boolean;
  compact?: boolean;
  beforeDetails?: ReactNode;
  children?: ReactNode;
  model: AuthorityReviewModel | null;
  growth: readonly BoundaryGrowth[] | undefined;
  problems: readonly string[];
  loading: boolean;
}) {
  const { t, tn } = useI18n();
  if (loading || !model)
    return loading ? <RowsSkeleton count={4} testId="authority-review-loading" /> : null;
  const { tiles, sentence, comparison } = model;
  const growthText = sentence.kind === "growth" ? growthLine(t, growth) : null;
  const groups = (
    <>
      {model.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("authority.noEffects")}</p>
      ) : (
        model.groups.map((group) => (
          <Group
            key={group.key}
            group={group}
            toolPinsCompared={toolPinsCompared}
            toolNotesAbove={compact}
          />
        ))
      )}
      {model.groups.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="authority-review-runtime">
          {t("authority.review.runtimeValues")}
        </p>
      )}
    </>
  );
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="authority-effect-review">
      {problems.length > 0 && (
        <details
          open
          className="rounded-md border border-destructive/50 px-3 text-sm text-destructive"
          data-testid="authority-review-problems"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <TriangleExclamationPoint aria-hidden="true" className="size-4 shrink-0" />
            {t("authority.review.problem")}
          </summary>
          <ul className="flex flex-col gap-1 pb-3 pl-6">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="rounded-xl border bg-secondary p-6" data-testid="authority-review-tiles">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4" aria-hidden />
          {t("ops.boundary")}:
          <span className="font-mono" data-testid="authority-review-summary">
            {[
              tn("ops.boundary.reads", tiles.read),
              tn("ops.boundary.writes", tiles.write),
              tn("ops.boundary.services", tiles.services),
            ].join(" · ")}
          </span>
          {tiles.risky > 0 ? (
            <span className="font-mono text-destructive-ink">
              · {tn("ops.boundary.risky", tiles.risky)}
            </span>
          ) : null}
        </div>
        {sentence.kind !== "none" && (
          <p
            className={cn("mt-1 text-sm", sentence.kind === "growth" && "text-warning-ink")}
            data-testid="authority-review-sentence"
          >
            {sentence.kind === "readOnly"
              ? t("authority.review.readOnly", { scope: sentence.scope, service: sentence.service })
              : sentence.kind === "writes"
                ? t("authority.review.writes", { service: sentence.service })
                : growthText}
          </p>
        )}
        {model.secrets.length > 0 && (
          <p
            className="mt-1 flex flex-wrap items-center gap-1.5 text-sm"
            data-testid="authority-review-vault"
          >
            <KeyRound className="size-4 shrink-0" aria-hidden />
            {t("authority.review.vault", { names: model.secrets.join(", ") })}
          </p>
        )}
        <ServiceChips className="mt-3" refs={model.groups.map((group) => group.name)} />
      </div>
      {comparison && (
        <p
          className="flex flex-wrap items-center gap-1.5 text-xs"
          data-testid="authority-review-comparison"
        >
          {comparison.version !== null && (
            <span className="text-muted-foreground">
              {t(
                comparison.approved
                  ? "authority.review.compared"
                  : "authority.review.comparedUnapproved",
                { version: `v${comparison.version}` },
              )}
            </span>
          )}
          {(["added", "widened", "unchanged", "removed"] as const).map((kind) =>
            comparison[kind] > 0 ? (
              <span key={kind} className={CHIP}>
                {t(`authority.review.change.${kind}`, { count: comparison[kind] })}
              </span>
            ) : null,
          )}
        </p>
      )}
      {compact ? <ToolNotes model={model} toolPinsCompared={toolPinsCompared} /> : null}
      {beforeDetails}
      {compact ? (
        <CollapsibleSection
          label={t("authority.review.details")}
          count={model.groups.reduce((sum, group) => sum + group.rows.length, 0)}
          testId="authority-effect-details"
        >
          <div className="flex min-w-0 flex-col gap-3">
            {groups}
            {children}
          </div>
        </CollapsibleSection>
      ) : (
        <>
          {groups}
          {children}
        </>
      )}
    </div>
  );
}
