import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
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
  const pending = Boolean(submit?.pending);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(dialogWidthClass(size), DIALOG_FRAME)}
        showCloseButton={false}
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
                <DialogTitle className={DIALOG_TITLE} data-testid={`${testId}-title`}>
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
              data-testid={`${testId}-cancel`}
            >
              {t("common.cancel")}
            </Button>
            {submit ? (
              <Button
                type="submit"
                disabled={pending || submit.disabled}
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
