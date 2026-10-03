import { ChevronLeft, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/cockpit/icon-button";

/**
 * One dialog anatomy (P13, P14), shared by FormDialog and ConfirmDialog:
 *
 * - head: an optional "‹ Zurück", the title with the close ×, an optional
 *   one-line description;
 * - body: scrolls; a 16px rhythm, labels above full-width controls, a
 *   SegmentedControl's segments stretched evenly;
 * - the one error line, above the footer;
 * - footer: a separating rule, ghost "Abbrechen" and one filled verb (red
 *   where it removes), right-aligned.
 *
 * Two widths, 512px and 576px; under 640px a full-width sheet from the
 * bottom edge.
 */
export type DialogSize = "default" | "wide";

/** The two dialog widths (§4): `sm:max-w-lg` (512px), and `sm:max-w-xl` (576px). */
export function dialogWidthClass(size: DialogSize): string {
  return size === "wide" ? "sm:max-w-xl" : "sm:max-w-lg";
}

/** The frame: no padding of its own, its parts set the rhythm; a bottom sheet on a phone. */
export const DIALOG_FRAME =
  "flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden bg-background p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-1.5rem)] max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none";

export const DIALOG_HEAD =
  "grid flex-none gap-1 px-6 pt-5 pb-4 max-sm:px-4 max-sm:pt-4 max-sm:pb-3";
export const DIALOG_TITLE =
  "min-w-0 text-lg leading-7 font-semibold tracking-tight [overflow-wrap:anywhere]";
export const DIALOG_DESCRIPTION = "text-sm text-muted-foreground";
export const DIALOG_BODY =
  "grid min-h-0 min-w-0 flex-1 content-start gap-4 overflow-auto px-6 pb-6 max-sm:px-4 max-sm:pb-5 [&_[data-slot=segmented-control]]:flex [&_[data-slot=segmented-control]]:w-full [&_[data-slot=segmented-control]>*]:flex-1";
export const DIALOG_ERROR = "flex-none px-6 pb-4 text-sm text-destructive max-sm:px-4 max-sm:pb-3";
export const DIALOG_FOOT =
  "m-0 flex flex-none flex-row flex-wrap justify-end gap-2 rounded-none border-t bg-transparent px-6 py-4 max-sm:px-4 max-sm:py-3 sm:flex-row sm:justify-end";

/** The verb that removes: red, as filled as any other verb. */
export const FILLED_DESTRUCTIVE =
  "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40";

/** "‹ Zurück", above the title of a dialog's second step. */
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
      className="-ml-1 mb-1 flex min-h-8 w-fit items-center gap-0.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-slot="dialog-back"
      data-testid={testId}
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

/** The title row: the title and, at its end, the close ×. */
export function DialogTitleRow({
  title,
  closeLabel,
  onClose,
  disabled,
  testId,
}: {
  /** The primitive's own title element, so the dialog stays labelled. */
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
