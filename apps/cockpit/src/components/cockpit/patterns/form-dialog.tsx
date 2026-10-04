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
  description?: string;
  submit?: {
    label: string;
    pending?: boolean;
    disabled?: boolean;
    destructive?: boolean;
    testId?: string;
  };
  onSubmit?(): void | Promise<void>;
  error?: string | null;
  back?: { label: string; onClick(): void; testId?: string };
  step?: string;
  actions?: ReactNode;
  trigger?: ReactNode;
  titleTestId?: string;
  cancelTestId?: string;
  size?: DialogSize;
  testId: string;
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
