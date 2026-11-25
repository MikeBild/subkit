import { Button } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { ErrorNotice } from "@ui/molecules/error-notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@ui/organisms/dialog";
import {
  DIALOG_BODY,
  DIALOG_DESCRIPTION,
  DIALOG_FOOT,
  DIALOG_FRAME,
  DIALOG_HEAD,
  DIALOG_NOTICE,
  DIALOG_TITLE,
  DialogBack,
  type DialogError,
  type DialogSize,
  DialogTitleRow,
  dialogErrorCause,
  dialogErrorText,
  dialogWidthClass,
  FILLED_DESTRUCTIVE,
} from "@ui/organisms/dialog-frame";
import { type ReactNode, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n-context";
import { renderAction } from "./action-button";
import { ActionFailureHost, failureRemedyAction } from "./action-failure";
import { useRemedyHref } from "./remedy-links";
import { useErrorNotice } from "./use-error-detail";

export {
  type DialogError,
  type DialogSize,
  dialogFailure,
  dialogWidthClass,
} from "@ui/organisms/dialog-frame";

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submit,
  onSubmit,
  error,
  failure,
  back,
  step,
  actions,
  trigger,
  titleTestId,
  cancelTestId,
  cancelLabel,
  cancel = true,
  size = "default",
  hint,
  cancelHint,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  submit?: {
    label: ReactNode;
    pending?: boolean;
    disabled?: boolean;
    destructive?: boolean;
    testId?: string;
    hint?: string;
  };
  onSubmit?(): void | Promise<void>;
  error?: DialogError;
  failure?: unknown;
  back?: { label: string; onClick(): void; testId?: string };
  step?: string;
  actions?: ReactNode;
  trigger?: ReactNode;
  titleTestId?: string;
  cancelTestId?: string;
  cancelLabel?: string;
  cancel?: boolean;
  size?: DialogSize;
  hint?: string;
  cancelHint?: string;
  testId: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const remedyHref = useRemedyHref();
  const pending = Boolean(submit?.pending);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined")
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  const errorText = dialogErrorText(error);
  const cause = dialogErrorCause(error, failure);
  const notice = useErrorNotice({ error: cause ?? undefined, tone: cause ? "error" : "warn" });
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
        onCloseAutoFocus={(event) => {
          const target = opener.current;
          if (trigger || !target?.isConnected || target === document.body) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
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
            <ActionFailureHost className="mt-2" />
          </div>
          {errorText ? (
            <div className={DIALOG_NOTICE}>
              <ErrorNotice
                {...notice}
                title={errorText}
                testId={`${testId}-error`}
                actions={renderAction(
                  cause
                    ? failureRemedyAction(
                        {
                          title: errorText,
                          error: cause,
                          testId: `${testId}-error-remedy`,
                          ...(submit && onSubmit && !submit.disabled
                            ? { retry: () => void onSubmit() }
                            : {}),
                        },
                        t,
                        remedyHref,
                      )
                    : undefined,
                )}
              />
            </div>
          ) : null}
          <FormDialogFoot hint={hint} testId={testId}>
            {cancel ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => onOpenChange(false)}
                data-testid={cancelTestId ?? `${testId}-cancel`}
                {...(cancelHint ? { title: cancelHint, "data-hint": cancelHint } : {})}
              >
                {cancelLabel ?? t("common.cancel")}
              </Button>
            ) : null}
            {actions}
            {submit ? (
              <Button
                type="submit"
                disabled={pending || submit.disabled}
                className={submit.destructive ? FILLED_DESTRUCTIVE : undefined}
                data-testid={submit.testId ?? `${testId}-submit`}
                {...(submit.hint ? { title: submit.hint, "data-hint": submit.hint } : {})}
              >
                {submit.label}
              </Button>
            ) : null}
          </FormDialogFoot>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FormDialogFoot({
  hint,
  testId,
  children,
}: {
  hint?: string;
  testId: string;
  children: ReactNode;
}) {
  const [shownHint, setShownHint] = useState<string | null>(null);
  const pointHint = (target: EventTarget) =>
    setShownHint(
      target instanceof Element
        ? (target.closest("[data-hint]")?.getAttribute("data-hint") ?? null)
        : null,
    );
  return (
    <DialogFooter
      className={cn(
        DIALOG_FOOT,
        hint !== undefined && "max-sm:flex-col-reverse max-sm:items-stretch",
      )}
      {...(hint !== undefined
        ? {
            onMouseOver: (event) => pointHint(event.target),
            onFocus: (event) => pointHint(event.target),
            onMouseLeave: () => setShownHint(null),
            onBlur: () => setShownHint(null),
          }
        : {})}
    >
      {hint !== undefined ? (
        <p
          className="order-first min-h-4 basis-full truncate text-xs text-muted-foreground"
          aria-live="polite"
          title={shownHint ?? hint}
          data-testid={`${testId}-hint`}
        >
          {shownHint ?? hint}
        </p>
      ) : null}
      {children}
    </DialogFooter>
  );
}
