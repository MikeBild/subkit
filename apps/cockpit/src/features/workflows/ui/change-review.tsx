import { Button } from "@ui/atoms/button";
import { Checkbox } from "@ui/atoms/checkbox";
import { cn } from "@ui/lib/utils";
import { CircleCheck, CircleExclamationPoint } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { CodeBlock, CollapsibleSection } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { computeLineDiff, focusDiff, toDiffLines } from "@/lib/line-diff";
import {
  acceptBlockedKey,
  acceptDigest,
  acceptedIndices,
  type ChangeTestResult,
  type ReviewChange,
  selectAll,
  selectionKey,
  selectionScope,
  type TestedSelection,
  testedFor,
  toggleSelection,
} from "../model/change-review";
import { FocusedDiff } from "./diff-card";

export interface ChangeReviewState {
  total: number;
  selection: ReadonlySet<number>;
  accepted: number[];
  partial: boolean;
  toggle: (index: number) => void;
  canTest: boolean;
  testing: boolean;
  test: () => void;
  result: ChangeTestResult | null;
  stale: boolean;
  blockedKey: ReturnType<typeof acceptBlockedKey>;
  digest: string | null;
}

export function useChangeReview(input: {
  total: number;
  digestRequired: boolean;
  fullDigest?: string | null | undefined;
  onTest?: ((accepted: number[]) => Promise<ChangeTestResult>) | undefined;
}): ChangeReviewState {
  const { total, digestRequired, fullDigest, onTest } = input;
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);
  const [tested, setTested] = useState<TestedSelection | null>(null);
  const [testing, setTesting] = useState(false);
  const selection = useMemo(() => picked ?? selectAll(total), [picked, total]);
  const accepted = useMemo(() => acceptedIndices(selection, total), [selection, total]);
  const scope = selectionScope(selection, total);
  const key = selectionKey(selection, total);
  const toggle = useCallback(
    (index: number) => setPicked((current) => toggleSelection(current ?? selectAll(total), index)),
    [total],
  );
  const test = useCallback(() => {
    if (!onTest || testing || accepted.length === 0) return;
    setTesting(true);
    onTest(accepted)
      .catch(
        (error: unknown): ChangeTestResult => ({
          ok: false,
          error: error instanceof Error ? error.message : null,
          digest: null,
        }),
      )
      .then((result) => setTested({ key, result }))
      .finally(() => setTesting(false));
  }, [onTest, testing, accepted, key]);
  return {
    total,
    selection,
    accepted,
    partial: scope === "some",
    toggle,
    canTest: Boolean(onTest) && scope !== "none",
    testing,
    test,
    result: testedFor(tested, key),
    stale: tested !== null && tested.key !== key,
    blockedKey: acceptBlockedKey({ scope, key, tested, digestRequired }),
    digest: acceptDigest({ scope, key, tested, fullDigest }),
  };
}

export function ChangeReview({
  changes,
  review,
  disabled = false,
  testId,
}: {
  changes: readonly ReviewChange[];
  review: ChangeReviewState;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const choosable = changes.length > 1;
  const detailed = changes.filter(
    (change) => change.preview !== null || change.before !== null || change.after !== null,
  );
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      {choosable ? (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-intro`}>
          {t("changeReview.intro")}
        </p>
      ) : null}
      <ul className="flex min-w-0 flex-col gap-2">
        {changes.map((change) => {
          const checked = review.selection.has(change.index);
          const id = `${testId}-change-${change.index}`;
          return (
            <li
              key={change.index}
              className="flex min-w-0 items-start gap-3 rounded-md border p-3"
              data-testid={id}
              data-state={checked ? "accepted" : "left-out"}
            >
              {choosable ? (
                <Checkbox
                  id={`${id}-accept`}
                  className="mt-0.5"
                  checked={checked}
                  disabled={disabled || review.testing}
                  onCheckedChange={() => review.toggle(change.index)}
                  data-testid={`${id}-accept`}
                />
              ) : null}
              <label
                htmlFor={choosable ? `${id}-accept` : undefined}
                className={cn(
                  "min-w-0 text-sm [overflow-wrap:anywhere]",
                  !checked && "text-muted-foreground line-through",
                )}
              >
                {change.sentence}
              </label>
            </li>
          );
        })}
      </ul>
      {choosable ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-count`}>
          {t("changeReview.count", {
            accepted: String(review.accepted.length),
            total: String(review.total),
          })}
        </p>
      ) : null}
      <ChangeTestLine review={review} testId={`${testId}-test`} />
      {detailed.length > 0 ? (
        <CollapsibleSection label={t("decisions.changeDetail")} testId={`${testId}-code`}>
          <div className="flex min-w-0 flex-col gap-3">
            {detailed.map((change) => (
              <div key={change.index} className="flex min-w-0 flex-col gap-1">
                <p className="text-muted-foreground text-xs">{change.sentence}</p>
                {change.preview !== null ? (
                  <CodeBlock code={change.preview} testId={`${testId}-code-${change.index}`} />
                ) : (
                  <FocusedDiff
                    rows={focusDiff(
                      computeLineDiff(
                        change.before === null ? [] : toDiffLines(change.before),
                        change.after === null ? [] : toDiffLines(change.after),
                      ),
                    )}
                    testId={`${testId}-code-${change.index}`}
                  />
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      ) : null}
    </section>
  );
}

function ChangeTestLine({ review, testId }: { review: ChangeReviewState; testId: string }) {
  const { t } = useI18n();
  if (review.testing)
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite" data-testid={testId}>
        {t("changeReview.testing")}
      </p>
    );
  if (review.stale)
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite" data-testid={testId}>
        {t("changeReview.test.stale")}
      </p>
    );
  const result = review.result;
  if (!result) return null;
  const unavailable = !result.ok && result.error === null;
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-sm",
        result.ok ? "text-success-ink" : unavailable ? "text-muted-foreground" : "text-destructive",
      )}
      aria-live="polite"
      data-testid={testId}
      data-state={result.ok ? "passed" : unavailable ? "unavailable" : "failed"}
    >
      {result.ok ? (
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      ) : unavailable ? null : (
        <CircleExclamationPoint aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {result.ok
          ? t("changeReview.test.passed")
          : unavailable
            ? t("changeReview.test.unavailable")
            : t("changeReview.test.failed", { error: result.error ?? "" })}
      </span>
    </p>
  );
}

export function ChangeReviewActions({
  review,
  busy = false,
  blocked = false,
  onAccept,
  onAcceptAndSave,
  testId,
}: {
  review: ChangeReviewState;
  busy?: boolean;
  blocked?: boolean;
  onAccept?: (() => void) | undefined;
  onAcceptAndSave?: (() => void) | undefined;
  testId: string;
}) {
  const { t } = useI18n();
  const held = busy || blocked || review.testing || review.blockedKey !== null;
  const title = review.blockedKey ? t(review.blockedKey) : undefined;
  return (
    <>
      {review.canTest || review.testing ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || review.testing || !review.canTest}
          aria-busy={review.testing || undefined}
          onClick={review.test}
          data-testid={`${testId}-test-first`}
        >
          {t(review.testing ? "changeReview.testing" : "changeReview.testFirst")}
        </Button>
      ) : null}
      {onAccept ? (
        <Button
          variant={onAcceptAndSave ? "outline" : "default"}
          size="sm"
          disabled={held}
          title={title}
          onClick={onAccept}
          data-testid={`${testId}-accept`}
        >
          {t("changeReview.accept")}
        </Button>
      ) : null}
      {onAcceptAndSave ? (
        <Button
          size="sm"
          disabled={held}
          title={title}
          onClick={onAcceptAndSave}
          data-testid={`${testId}-accept-save`}
        >
          {t("changeReview.acceptAndSave")}
        </Button>
      ) : null}
    </>
  );
}
