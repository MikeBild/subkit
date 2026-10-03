import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export type DialogSize = "default" | "wide";

/** The two dialog widths (§4): `sm:max-w-lg` (512px), and `sm:max-w-xl` (576px). */
export function dialogWidthClass(size: DialogSize): string {
  return size === "wide" ? "sm:max-w-xl" : "sm:max-w-lg";
}

/**
 * The one dialog frame, shared by FormDialog and ConfirmDialog: centred at
 * one of the two widths, its body scrolling inside the screen's height; under
 * 640px a full-width sheet from the bottom edge.
 */
export const DIALOG_FRAME =
  "flex max-h-[calc(100dvh-2rem)] flex-col max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-1rem)] max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none";

/** The filled verb of a dialog that removes: red, as filled as any other verb. */
export const FILLED_DESTRUCTIVE =
  "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40";

/**
 * Create, rename, invite and approve (P14). One anatomy: the title with an
 * optional one-line description and the close ×; the fields, labels above,
 * full width, at a 16px rhythm, the body scrolling; the one error line above
 * the footer; the footer with ghost "Abbrechen" and one filled verb (red
 * where it removes).
 *
 * A dialog of two steps keeps its width: its first step offers ChoiceCards
 * and only "Abbrechen" (no `submit`); its second has "‹ Zurück" (`back`)
 * above the title. `step` names the step shown; a new one fades in.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submit,
  onSubmit,
  error,
  back,
  step,
  size = "default",
  testId,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  /** One line under the title. */
  description?: string;
  /** Omitted: the step's choices proceed by themselves. */
  submit?: { label: string; pending?: boolean; disabled?: boolean; destructive?: boolean };
  onSubmit?(): void | Promise<void>;
  /** The one error line, above the footer. */
  error?: string | null;
  /** Back to the previous step. */
  back?: { label: string; onClick(): void; testId?: string };
  step?: string;
  size?: DialogSize;
  testId: string;
  /** The fields. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(dialogWidthClass(size), DIALOG_FRAME)}
        closeLabel={t("common.close")}
        aria-describedby={undefined}
        data-testid={testId}
      >
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (submit && onSubmit) void onSubmit();
          }}
        >
          <DialogHeader className="pr-8">
            {back ? (
              <button
                type="button"
                onClick={back.onClick}
                disabled={submit?.pending}
                className="-ml-1 flex min-h-8 w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                data-testid={back.testId ?? `${testId}-back`}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
                {back.label}
              </button>
            ) : null}
            <DialogTitle data-testid={`${testId}-title`}>{title}</DialogTitle>
            {description ? (
              <DialogDescription data-testid={`${testId}-description`}>
                {description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <div
            key={step}
            className={cn(
              "-mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 [&_[data-slot=segmented-control]]:w-full [&_[data-slot=segmented-control]>*]:flex-1",
              step !== undefined && "sk-fade-in",
            )}
            data-slot="dialog-body"
            data-dialog-step={step}
          >
            {children}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive" data-testid={`${testId}-error`}>
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submit?.pending}
              onClick={() => onOpenChange(false)}
              data-testid={`${testId}-cancel`}
            >
              {t("common.cancel")}
            </Button>
            {submit ? (
              <Button
                type="submit"
                disabled={submit.pending || submit.disabled}
                className={submit.destructive ? FILLED_DESTRUCTIVE : undefined}
                data-testid={`${testId}-submit`}
              >
                {submit.label}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
