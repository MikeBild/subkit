import { Button } from "@ui/atoms/button";
import { useI18n, useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui/organisms/alert-dialog";
import {
  DIALOG_DESCRIPTION,
  DIALOG_FOOT,
  DIALOG_FRAME,
  DIALOG_HEAD,
  DIALOG_TITLE,
  DialogTitleRow,
  dialogWidthClass,
  FILLED_DESTRUCTIVE,
} from "@ui/organisms/dialog-frame";
import { type ReactNode, useRef, useState } from "react";

type ConfirmTitle = { title: string } | { object: string; verb: string };

export type ConfirmDialogProps = ConfirmTitle & {
  open?: boolean;
  onOpenChange?(open: boolean): void;
  trigger?: ReactNode;
  consequence: ReactNode;
  points?: readonly string[];
  confirmLabel?: string;
  dismissLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm(): void | Promise<void>;
  testId: string;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    onOpenChange,
    trigger,
    consequence,
    points,
    confirmLabel,
    dismissLabel,
    destructive = false,
    pending = false,
    onConfirm,
    testId,
  } = props;
  const { t } = useI18n();
  const { dialogNotice } = useUi();
  const [ownOpen, setOwnOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = open ?? ownOpen;
  const opener = useRef<HTMLElement | null>(null);
  const wasShown = useRef(false);
  if (shown && !wasShown.current && typeof document !== "undefined")
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasShown.current = shown;
  const setShown = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const working = pending || busy;
  const title = "title" in props ? props.title : t.confirm.title(props.object, props.verb);
  const action = confirmLabel ?? ("verb" in props ? props.verb : t.confirm.action);
  return (
    <AlertDialog open={shown} onOpenChange={setShown}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent
        data-testid={testId}
        className={cn(dialogWidthClass("default"), DIALOG_FRAME)}
        onCloseAutoFocus={(event) => {
          const target = opener.current;
          if (trigger || !target?.isConnected || target === document.body) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
      >
        <div className={DIALOG_HEAD} data-slot="dialog-head">
          <DialogTitleRow
            title={
              <AlertDialogTitle className={DIALOG_TITLE} data-testid={`${testId}-title`}>
                {title}
              </AlertDialogTitle>
            }
            closeLabel={t.common.close}
            onClose={() => setShown(false)}
            disabled={working}
            testId={testId}
          />
          <AlertDialogDescription
            className={DIALOG_DESCRIPTION}
            data-testid={`${testId}-consequence`}
          >
            {consequence}
          </AlertDialogDescription>
          {points && points.length > 0 ? (
            <ul
              className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground"
              data-testid={`${testId}-points`}
            >
              {points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          ) : null}
          {dialogNotice}
        </div>
        <AlertDialogFooter className={DIALOG_FOOT}>
          <AlertDialogCancel variant="ghost" disabled={working} data-testid={`${testId}-cancel`}>
            {dismissLabel ?? t.common.cancel}
          </AlertDialogCancel>
          <Button
            variant="default"
            className={destructive ? FILLED_DESTRUCTIVE : undefined}
            disabled={working}
            data-testid={`${testId}-confirm`}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                if (open === undefined) setOwnOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
