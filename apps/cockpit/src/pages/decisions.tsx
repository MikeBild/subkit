import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import { useSession } from "@/app/session";
import { useDecisionQueue } from "@/app/use-decisions";
import { DecisionCard } from "@/components/cockpit/decision-card";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  type DecidableItem,
  type DecidableKind,
  type DecisionItem,
  filterByKinds,
  type GroupMode,
  groupDecisions,
  isDecidable,
  type OpenDecisions,
  partitionByUrgency,
} from "./decisions-model";

/**
 * The kinds this page decides. A waiting conversation is not one of them.
 *
 * Measured on 21.08.2026: the page reported "35 offen · Korrekturen 2 ·
 * Skill-Vorschläge 1 · Unterhaltungen 32" — and 32 of those 35 positions
 * carried no approve and no reject, because a question asked inside a
 * conversation is answered inside that conversation. They are counted and
 * named on the tile above, which leads to the list where they can be answered
 * (§8.5a, §8.5b).
 */
const KINDS: DecidableKind[] = ["patch", "skill"];
const GROUP_MODES: GroupMode[] = ["none", "kind", "source"];
const KIND_LABEL: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
};
/** The tile names the category in the plural; the chip below names the kind. */
const TILE_LABEL: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.tile.patch",
  skill: "decisions.tile.skill",
};

const GROUP_LABEL: Record<GroupMode, TranslationKey> = {
  none: "decisions.group.none",
  kind: "decisions.group.kind",
  source: "decisions.group.source",
};
const PREFERENCE_KEY = "sk-cockpit-decisions";

interface Preferences {
  kinds: DecidableKind[];
  group: GroupMode;
}

function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return { kinds: [], group: "none" };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      kinds: Array.isArray(parsed.kinds)
        ? parsed.kinds.filter((kind): kind is DecidableKind =>
            KINDS.includes(kind as DecidableKind),
          )
        : [],
      group: GROUP_MODES.includes(parsed.group as GroupMode) ? (parsed.group as GroupMode) : "none",
    };
  } catch {
    return { kinds: [], group: "none" };
  }
}

function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
  } catch {
    // A cockpit that cannot persist a filter still works; the filter simply resets.
  }
}

export function DecisionsPage() {
  const { t } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const queue = useDecisionQueue(session.permissions);
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [decided, setDecided] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills = session.permissions.includes("skill:write");
  const title = t("nav.decisions");

  function persist(next: Preferences): void {
    setPreferences(next);
    writePreferences(next);
  }

  const decide = useMutation({
    mutationFn: async (input: { item: DecisionItem; approve: boolean; reason: string }) => {
      if (input.item.kind === "patch") {
        return input.approve
          ? approvePatchCandidate(input.item.id)
          : rejectPatchCandidate(input.item.id, input.reason);
      }
      return input.approve
        ? approveSkillCandidate(input.item.id)
        : rejectSkillCandidate(input.item.id, input.reason);
    },
    onMutate: (input) => {
      setBusyId(input.item.id);
      setDecided((ids) => [...ids, input.item.id]);
    },
    onSuccess: (_result, input) => {
      toast.success(t(input.approve ? "decisions.approved" : "decisions.rejected"));
      void queryClient.invalidateQueries({ queryKey: ["decisions"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (_error, input) => {
      setDecided((ids) => ids.filter((id) => id !== input.item.id));
      toast.error(t("decisions.decisionFailed"));
    },
    onSettled: () => setBusyId(null),
  });

  // Only what can be decided reaches the queue. `queue.items` still carries the
  // waiting conversations, because the counter and the incident banner are
  // about them — but they have no card here.
  const open = queue.items.filter(isDecidable).filter((item) => !decided.includes(item.id));
  const filtered = filterByKinds(open, preferences.kinds) as DecidableItem[];
  const urgency = partitionByUrgency(filtered, Date.now());
  const { current, aged } = urgency.deferred;
  const isFiltered = preferences.kinds.length > 0 && open.length > filtered.length;
  // The breakdown comes from the same count as the badge, not from the rows the
  // page happens to hold: the two disagreed the moment a source hit its cap.
  const counted = queue.open;

  if (!queue.sources.patches && !queue.sources.skills && !queue.sources.conversations)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  function renderGroups(items: DecidableItem[], prefix: string) {
    const groups = groupDecisions(items, preferences.group);
    let position = 0;
    return groups.map((group) => (
      <div key={group.key} className="grid gap-1.5 pt-2 first:pt-0">
        {preferences.group !== "none" && (
          <p className="text-xs font-medium text-muted-foreground">
            {preferences.group === "kind"
              ? t(KIND_LABEL[group.key as DecidableKind])
              : group.key || t("decisions.group.noSource")}
          </p>
        )}
        {group.items.map((item) => {
          const index = position++;
          return (
            <DecisionCard
              key={item.id}
              item={item as DecidableItem}
              index={index}
              testIdPrefix={prefix}
              names={queue.names}
              canReadRuns={queue.canReadRuns}
              busy={busyId === item.id}
              canDecide={item.kind === "patch" ? canDecidePatches : canDecideSkills}
              onApprove={(target) => decide.mutate({ item: target, approve: true, reason: "" })}
              onReject={(target, reason) => decide.mutate({ item: target, approve: false, reason })}
            />
          );
        })}
      </div>
    ));
  }

  return (
    <PageFrame
      testId="decisions-page"
      title={title}
      description={t("decisions.description")}
      scroll="page"
      action={
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="decisions-refresh"
          onClick={() => queue.refetch()}
        >
          <RefreshCw className={queue.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      }
    >
      <div className="grid gap-5">
        {counted !== null && counted.total > 0 && (
          <CategoryTiles
            counted={counted}
            shown={queue.items.length}
            selected={preferences.kinds}
            onSelect={(kinds) => persist({ ...preferences, kinds })}
          />
        )}
        <div className="flex flex-wrap items-center gap-2" data-testid="decisions-toolbar">
          <Button
            variant={preferences.kinds.length === 0 ? "default" : "outline"}
            size="sm"
            data-testid="decisions-chip-all"
            onClick={() => persist({ ...preferences, kinds: [] })}
          >
            {t("decisions.chip.all")}
          </Button>
          {/* Art-Chips only. §8.5 forbids a chip that puts the queue into a past
              STATE — decided, discarded, deferred — and there is none: this list
              is closed over the two kinds the page can act on. */}
          {KINDS.map((kind, index) => (
            <Button
              key={kind}
              variant={preferences.kinds.includes(kind) ? "default" : "outline"}
              size="sm"
              data-testid={`decisions-chip-${index}`}
              onClick={() =>
                persist({
                  ...preferences,
                  kinds: preferences.kinds.includes(kind)
                    ? preferences.kinds.filter((entry) => entry !== kind)
                    : [...preferences.kinds, kind],
                })
              }
            >
              {t(KIND_LABEL[kind])}
            </Button>
          ))}
          {/* The toggle says what it groups BY, so the label is part of the
              control rather than decoration: "Keine / Art / Verursacher" on
              their own name three things without saying of what. */}
          <span
            className="flex items-center gap-2 sm:ml-auto"
            data-testid="decisions-group"
            data-mode={preferences.group}
          >
            <span className="text-xs text-muted-foreground" data-testid="decisions-group-label">
              {t("decisions.group.label")}
            </span>
            {GROUP_MODES.map((mode, index) => (
              <Button
                key={mode}
                variant={preferences.group === mode ? "default" : "ghost"}
                size="sm"
                data-testid={`decisions-group-${index}`}
                data-mode={mode}
                aria-pressed={preferences.group === mode}
                onClick={() => persist({ ...preferences, group: mode })}
              >
                {t(GROUP_LABEL[mode])}
              </Button>
            ))}
          </span>
        </div>

        {queue.isPending ? (
          <div className="grid gap-2" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : queue.failed ? (
          <Alert variant="destructive" data-testid="decisions-error">
            <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
            <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              data-testid="decisions-retry"
              onClick={() => queue.refetch()}
            >
              {t("session.retry")}
            </Button>
          </Alert>
        ) : filtered.length === 0 ? (
          isFiltered ? (
            <div
              className="flex min-h-32 flex-col items-center justify-center rounded-lg border p-4 text-center"
              data-testid="decisions-empty-filtered"
            >
              <p className="text-sm font-medium">{t("decisions.emptyFiltered")}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                data-testid="decisions-show-all"
                onClick={() => persist({ ...preferences, kinds: [] })}
              >
                {t("decisions.showAll")}
              </Button>
            </div>
          ) : (
            <div
              className="flex min-h-32 flex-col items-center justify-center rounded-lg border p-4 text-center"
              data-testid="decisions-empty"
            >
              <CircleCheck
                aria-hidden="true"
                className="mx-auto size-6 text-emerald-600 dark:text-emerald-400"
              />
              <p className="mt-2 text-sm font-medium">{t("decisions.emptyTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("decisions.emptyDescription")}</p>
            </div>
          )
        ) : (
          // The queue's own copy of the one number, so a drift between the
          // tiles, the badge and this list is a failing assertion rather than
          // something a reader has to notice. `data-total` counts what this
          // list holds — the decidable positions — not the whole page.
          <div
            className="grid gap-5"
            data-testid="decisions-queue"
            data-total={String(counted?.decidable ?? 0)}
            data-capped={String(counted?.capped ?? false)}
          >
            {current.length > 0 && (
              <DecisionSection
                testId="decisions-current"
                title={t("decisions.section.deferred")}
                hint={t("decisions.section.deferredHint")}
                count={current.length}
              >
                {renderGroups(current as DecidableItem[], "decision-deferred")}
              </DecisionSection>
            )}
            {/* §8.2 names this rubric, and it is a rubric of its own rather
                than a sub-heading inside another one: it used to sit under
                a section headed "Kann warten", which is the product
                deciding on the reader's behalf what it has no way to know. */}
            {aged.length > 0 && (
              <DecisionSection
                testId="decisions-aged"
                title={t("decisions.agedTitle")}
                hint={t("decisions.agedHint")}
                count={aged.length}
              >
                {renderGroups(aged as DecidableItem[], "decision-aged")}
              </DecisionSection>
            )}
          </div>
        )}

        <HistoryLink />
      </div>
    </PageFrame>
  );
}

/**
 * §8.5a — one tile per category, each leading to the list it counts.
 *
 * This replaces a single run-on line ("35 offen · Korrekturen aus Läufen: 2 ·
 * Skill-Vorschläge: 1 · Unterhaltungen: 32") that stated four numbers and led
 * nowhere. There is no tile for anything settled, and there never may be: §8.5
 * allows counter tiles for what is open only.
 *
 * The conversation tile is the one that leaves this page, because that is where
 * its positions are answered.
 */
function CategoryTiles({
  counted,
  shown,
  selected,
  onSelect,
}: {
  counted: OpenDecisions;
  shown: number;
  selected: DecidableKind[];
  onSelect: (kinds: DecidableKind[]) => void;
}) {
  const { t } = useI18n();
  const only = (kind: DecidableKind): DecidableKind[] =>
    selected.length === 1 && selected[0] === kind ? [] : [kind];
  return (
    <div className="grid gap-2" data-testid="decisions-tiles">
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={cn(
              "rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
              selected.length === 1 && selected[0] === kind && "border-primary bg-muted/40",
            )}
            data-testid={`decisions-tile-${kind}`}
            data-count={String(counted.byKind[kind])}
            aria-pressed={selected.length === 1 && selected[0] === kind}
            onClick={() => onSelect(only(kind))}
          >
            <span className="block text-2xl font-semibold tabular-nums">
              {counted.byKind[kind]}
            </span>
            <span className="block text-sm">{t(TILE_LABEL[kind])}</span>
          </button>
        ))}
        <Link
          to="/chat"
          className="rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
          data-testid="decisions-tile-conversation"
          data-count={String(counted.byKind.conversation)}
        >
          <span className="block text-2xl font-semibold tabular-nums">
            {counted.byKind.conversation}
          </span>
          <span className="block text-sm">{t("decisions.tile.conversation")}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("decisions.tile.conversationHint")}
          </span>
        </Link>
      </div>
      {counted.capped && (
        <p className="text-xs text-muted-foreground" data-testid="decisions-capped">
          {t("decisions.capped", { shown: String(shown), total: String(counted.total) })}
        </p>
      )}
    </div>
  );
}

/**
 * §8.5 — the one way to the past, and the only one.
 *
 * Not a shelf, not a section, not a state chip: a sentence with a link. The
 * history it points at is complete because the audit log is append-only; what
 * the log does NOT cover is said on that page rather than implied here.
 */
function HistoryLink() {
  const { t } = useI18n();
  const session = useSession();
  if (!session.permissions.includes("audit:read")) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="decisions-history">
      {t("decisions.history.label")}{" "}
      <Link
        to="/audit"
        search={{ scope: "decisions" }}
        className="underline underline-offset-2"
        data-testid="decisions-history-link"
      >
        {t("decisions.history.link")}
      </Link>
    </p>
  );
}

/** One rubric of the queue: what it is, what it costs, and how many. */
function DecisionSection({
  testId,
  title,
  hint,
  count,
  muted = false,
  children,
}: {
  testId: string;
  title: string;
  hint: string;
  count: number;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    // The count is readable as a number, not only as rendered text: the banner
    // states a share of this rubric, and the two are asserted against each
    // other rather than trusted to stay in step.
    <section
      className={cn("grid gap-2", muted && "opacity-70")}
      data-testid={testId}
      data-count={String(count)}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}
