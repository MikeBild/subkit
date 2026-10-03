import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { Button } from "./button";

interface BarAction {
  onClick(): void;
  /** The label, where the default ("Verwerfen" / "Speichern") is not the act. */
  label?: string;
  pending?: boolean;
  disabled?: boolean;
  testId?: string;
}

/**
 * Unsaved changes, at the bottom of what holds them (P22): "N ungespeicherte
 * Änderungen · Verwerfen · Speichern". It stands only while there is
 * something to save — the caller renders it then and only then — and while
 * it stands it owns the view's one filled button. Settings, a skill's draft
 * and a person's role all use this bar.
 */
export function SaveBar({
  count,
  line,
  notice,
  discard,
  save,
  testId,
}: {
  /** How many changes wait; drawn as "N ungespeicherte Änderungen". */
  count: number;
  /** A line of its own instead of the count. */
  line?: string;
  /** A second line that must be read before saving, e.g. a conflict. */
  notice?: ReactNode;
  discard: BarAction;
  save: BarAction;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-slot="save-bar"
      data-testid={testId}
      className="sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-3"
    >
      <div className="min-w-0 text-sm">
        <p className="font-medium">
          {line ??
            t(count === 1 ? "pattern.saveBar.unsaved.one" : "pattern.saveBar.unsaved", { count })}
        </p>
        {notice ? <div className="text-xs text-destructive">{notice}</div> : null}
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          disabled={discard.disabled || save.pending}
          onClick={discard.onClick}
          data-testid={discard.testId ?? `${testId ?? "save-bar"}-discard`}
        >
          {discard.label ?? t("common.discard")}
        </Button>
        <Button
          pending={save.pending}
          disabled={save.disabled}
          onClick={save.onClick}
          data-testid={save.testId ?? `${testId ?? "save-bar"}-save`}
        >
          {save.label ?? t("common.save")}
        </Button>
      </div>
    </div>
  );
}
