import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { Button } from "./button";

interface BarAction {
  onClick(): void;
  label?: string;
  pending?: boolean;
  disabled?: boolean;
  testId?: string;
}

export function SaveBar({
  count,
  line,
  notice,
  description,
  discard,
  save,
  secondary,
  testId,
}: {
  count: number;
  line?: string;
  notice?: ReactNode;
  description?: ReactNode;
  discard: BarAction;
  save: BarAction;
  secondary?: ReactNode;
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
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {notice ? <div className="text-xs text-destructive">{notice}</div> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          disabled={discard.disabled || save.pending}
          onClick={discard.onClick}
          data-testid={discard.testId ?? `${testId ?? "save-bar"}-discard`}
        >
          {discard.label ?? t("common.discard")}
        </Button>
        {secondary}
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
