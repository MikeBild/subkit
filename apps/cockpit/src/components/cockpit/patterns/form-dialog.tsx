import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  DIALOG_BODY,
  DIALOG_DESCRIPTION,
  DIALOG_ERROR,
  DIALOG_FOOT,
  DIALOG_FRAME,
  DIALOG_HEAD,
  DIALOG_TITLE,
  DialogBack,
  type DialogSize,
  DialogTitleRow,
  dialogWidthClass,
  FILLED_DESTRUCTIVE,
} from "./dialog-frame";

export { type DialogSize, dialogWidthClass } from "./dialog-frame";

/**
 * Create, rename, invite and approve (P14), in the one dialog anatomy (see
 * `dialog-frame`): head · body · error line · footer.
 *
 * A dialog of two steps keeps its width: its first step offers ChoiceCards
 * and only "Abbrechen" (no `submit`); its second has "‹ Zurück" (`back`)
 * above the title. `step` names the step shown; a new one fades in.
 *
 * A review that offers more than one way on (the approval dialog: re-check,
 * adjust, a smaller decision) puts them in `actions`, before the one filled
 * verb; `trigger` is the dialog's own opener where it has one.
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
  actions,
  trigger,
  titleTestId,
  cancelTestId,
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
  submit?: {
    label: string;
    pending?: boolean;
    disabled?: boolean;
    destructive?: boolean;
    testId?: string;
  };
  onSubmit?(): void | Promise<void>;
  /** The one error line, above the footer. */
  error?: string | null;
  /** Back to the previous step. */
  back?: { label: string; onClick(): void; testId?: string };
  step?: string;
  /** Further ways on, in the footer before the filled verb (outline). */
  actions?: ReactNode;
  /** The dialog's own opener. */
  trigger?: ReactNode;
  titleTestId?: string;
  cancelTestId?: string;
  size?: DialogSize;
  testId: string;
  /** The fields. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const pending = Boolean(submit?.pending);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className={cn(dialogWidthClass(size), DIALOG_FRAME)}
        showCloseButton={false}
        // Focus lands on the dialog, not on its close ×: a focused × opens its
        // tooltip, and the first Escape would close the tooltip, not the dialog.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        aria-describedby={undefined}
        data-testid={testId}
      >
        <form
          className={cn("flex min-h-0 flex-1 flex-col", step !== undefined && "sk-fade-in")}
          key={step}
          data-dialog-step={step}
          onSubmit={(event) => {
            event.preventDefault();
            if (submit && onSubmit) void onSubmit();
          }}
        >
          <div className={DIALOG_HEAD} data-slot="dialog-head">
            {back ? (
              <DialogBack
                label={back.label}
                onClick={back.onClick}
                disabled={pending}
                testId={back.testId ?? `${testId}-back`}
              />
            ) : null}
            <DialogTitleRow
              title={
                <DialogTitle
                  className={DIALOG_TITLE}
                  data-testid={titleTestId ?? `${testId}-title`}
                >
                  {title}
                </DialogTitle>
              }
              closeLabel={t("common.close")}
              onClose={() => onOpenChange(false)}
              disabled={pending}
              testId={testId}
            />
            {description ? (
              <DialogDescription
                className={DIALOG_DESCRIPTION}
                data-testid={`${testId}-description`}
              >
                {description}
              </DialogDescription>
            ) : null}
          </div>
          <div className={DIALOG_BODY} data-slot="dialog-body">
            {children}
          </div>
          {error ? (
            <p role="alert" className={DIALOG_ERROR} data-testid={`${testId}-error`}>
              {error}
            </p>
          ) : null}
          <DialogFooter className={DIALOG_FOOT}>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
              data-testid={cancelTestId ?? `${testId}-cancel`}
            >
              {t("common.cancel")}
            </Button>
            {actions}
            {submit ? (
              <Button
                type="submit"
                disabled={pending || submit.disabled}
                className={submit.destructive ? FILLED_DESTRUCTIVE : undefined}
                data-testid={submit.testId ?? `${testId}-submit`}
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
