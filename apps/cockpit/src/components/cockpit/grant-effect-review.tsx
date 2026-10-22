import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  type LucideIcon,
  PenLine,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { RowsSkeleton } from "@/components/cockpit/patterns";
import { type BoundaryGrowth, growthLine } from "@/lib/authority-growth";
import { CLASS_KEYS, presentRequestBoundary } from "@/lib/authority-request";
import type { AuthorityReviewModel, ReviewGroup, ReviewRow } from "@/lib/authority-review-model";
import { presentStorageScope } from "@/lib/authority-storage";
import { effectLabel } from "@/lib/effect-label";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { AUTHORITY_EFFECT_KEYS } from "@/lib/workflow-authorities";

const ICONS: Record<ReviewRow["effect"], LucideIcon> = {
  read: BookOpen,
  write: PenLine,
  destructive: Trash2,
  unknown: CircleHelp,
};

const TONE = {
  read: "text-muted-foreground",
  write: "text-amber-700 dark:text-amber-400",
  risky: "text-destructive",
} as const;

const CHIP = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

function Chevron() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
    />
  );
}

function RowDetails({ row }: { row: ReviewRow }) {
  const { t, tn, locale } = useI18n();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const effect = row.source;
  const request = effect.boundary ? presentRequestBoundary(effect.boundary, number) : null;
  const storage = effect.storage ? presentStorageScope(effect.storage, number) : null;
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
            <p>{t(request.body.key, request.body.values)}</p>
            {effect.boundary.pagination && (
              <p>
                {t("authority.review.paging", {
                  params: effect.boundary.pagination.params.join(", "),
                })}
              </p>
            )}
            <p>{tn("authority.boundary.calls", effect.boundary.max_calls)}</p>
            {request.declaredDestructive && <p>{t("authority.boundary.declaredDestructive")}</p>}
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

function EffectRow({ row }: { row: ReviewRow }) {
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
          <p
            className="text-amber-700 dark:text-amber-400"
            data-testid={`authority-effect-unbound-${row.step_id}`}
          >
            {t("authority.review.unbound", { names: row.unbound.join(", ") })}
          </p>
        )}
        <RowDetails row={row} />
      </div>
    </details>
  );
}

function Group({ group }: { group: ReviewGroup }) {
  const { t } = useI18n();
  return (
    <details
      open={group.open}
      className="group/group rounded-md border"
      data-testid="authority-effect-group"
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 [&::-webkit-details-marker]:hidden">
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
          <EffectRow key={row.key} row={row} />
        ))}
      </div>
    </details>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={cn("flex flex-col rounded-md border px-3 py-2", tone)}>
      <span className="text-xs">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function GrantEffectReview({
  model,
  growth,
  problems,
  loading,
}: {
  model: AuthorityReviewModel | null;
  growth: readonly BoundaryGrowth[] | undefined;
  problems: readonly string[];
  loading: boolean;
}) {
  const { t } = useI18n();
  if (loading || !model)
    return loading ? <RowsSkeleton count={4} testId="authority-review-loading" /> : null;
  const { tiles, sentence, comparison } = model;
  const growthText = sentence.kind === "growth" ? growthLine(t, growth) : null;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="authority-effect-review">
      {problems.length > 0 && (
        <details
          open
          className="rounded-md border border-destructive/50 px-3 text-sm text-destructive"
          data-testid="authority-review-problems"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t("authority.review.problem")}
          </summary>
          <ul className="flex flex-col gap-1 pb-3 pl-6">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}
      <div
        className={cn("grid gap-2", tiles.risky > 0 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3")}
        id="authority-review-tiles"
        data-testid="authority-review-tiles"
      >
        <Tile label={t("authority.review.tile.read")} value={tiles.read} />
        <Tile
          label={t("authority.review.tile.write")}
          value={tiles.write}
          tone={tiles.write > 0 ? cn(TONE.write, "border-amber-500/50") : undefined}
        />
        <Tile label={t("authority.review.tile.services")} value={tiles.services} />
        {tiles.risky > 0 && (
          <Tile
            label={t("authority.review.tile.risky")}
            value={tiles.risky}
            tone={cn(TONE.risky, "border-destructive/50")}
          />
        )}
      </div>
      {sentence.kind !== "none" && (
        <p
          className={cn(
            "text-sm font-medium",
            sentence.kind === "growth" && "text-amber-700 dark:text-amber-400",
          )}
          data-testid="authority-review-sentence"
        >
          {sentence.kind === "readOnly"
            ? t("authority.review.readOnly", { scope: sentence.scope, service: sentence.service })
            : sentence.kind === "writes"
              ? t("authority.review.writes", { service: sentence.service })
              : growthText}
        </p>
      )}
      {comparison && (
        <p
          className="flex flex-wrap items-center gap-1.5 text-xs"
          data-testid="authority-review-comparison"
        >
          {comparison.version !== null && (
            <span className="text-muted-foreground">
              {t("authority.review.compared", { version: `v${comparison.version}` })}
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
      {model.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("authority.noEffects")}</p>
      ) : (
        model.groups.map((group) => <Group key={group.key} group={group} />)
      )}
      {model.groups.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="authority-review-runtime">
          {t("authority.review.runtimeValues")}
        </p>
      )}
    </div>
  );
}
