import { IconButton } from "@ui/molecules/icon-button";
import { ChevronLeft, XIcon } from "lucide-react";
import type { ReactNode } from "react";

export type DialogSize = "default" | "wide" | "document";

export function dialogWidthClass(size: DialogSize): string {
  if (size === "document") return "max-w-[960px]";
  return size === "wide" ? "sm:max-w-xl" : "sm:max-w-lg";
}

export const DIALOG_FRAME =
  "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden bg-background p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-1.5rem)] max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[env(safe-area-inset-bottom)]";

export const REVIEW_DIALOG_FRAME =
  "flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[720px] flex-col gap-0 overflow-hidden border border-border bg-background p-0 md:max-h-[calc(100dvh-48px)] sm:max-w-[720px] ring-0";

export const DIALOG_HEAD =
  "grid flex-none gap-1 px-6 pt-5 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-3";
export const DIALOG_TITLE =
  "min-w-0 text-lg leading-7 font-semibold tracking-tight [overflow-wrap:anywhere]";
export const DIALOG_DESCRIPTION = "text-sm text-muted-foreground";
export const DIALOG_BODY =
  "grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-auto overflow-x-hidden px-6 pb-6 max-sm:px-4 max-sm:pb-5 [&_[data-slot=segmented-control]]:flex [&_[data-slot=segmented-control]]:w-full [&_[data-slot=segmented-control]>*]:flex-1";
export interface DialogFailure {
  text: string;
  cause: unknown;
}

export type DialogError = string | DialogFailure | null;

export function dialogFailure(text: string, cause: unknown): DialogFailure {
  return { text, cause };
}

export function dialogErrorText(error: DialogError | undefined): string | null {
  if (!error) return null;
  return typeof error === "string" ? error : error.text;
}

export function dialogErrorCause(error: DialogError | undefined, failure?: unknown): unknown {
  if (failure !== undefined && failure !== null) return failure;
  return error && typeof error !== "string" ? error.cause : undefined;
}
export const DIALOG_NOTICE = "flex-none px-6 pb-4 max-sm:px-4 max-sm:pb-3";
export const DIALOG_FOOT =
  "m-0 flex flex-none flex-row flex-wrap justify-end gap-2 rounded-none border-t bg-transparent px-6 py-4 max-sm:px-4 max-sm:py-3 sm:flex-row sm:justify-end";

export const FILLED_DESTRUCTIVE =
  "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40";

export function DialogBack({
  label,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-ml-1 mb-1 flex min-h-8 w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground"
      data-slot="dialog-back"
      data-testid={testId}
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

export function DialogTitleRow({
  title,
  closeLabel,
  onClose,
  disabled,
  testId,
}: {
  title: ReactNode;
  closeLabel: string;
  onClose(): void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      {title}
      <IconButton
        type="button"
        label={closeLabel}
        className="-mt-0.5 -mr-2 flex-none"
        onClick={onClose}
        disabled={disabled}
        data-testid={`${testId}-close`}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}
